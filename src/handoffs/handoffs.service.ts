import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser } from '../common/decorators/auth.decorators';
import type { Prisma } from '../generated/prisma/client';
import { OrdersService, type FullOrder } from '../orders/orders.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { HANDOFF_RULES, type HandoffRule } from './handoff-rules';
import type {
  IssueHandoffDto,
  RevokeHandoffDto,
  VerifyHandoffDto,
} from './dto/handoffs.dto';

type Tx = Prisma.TransactionClient;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

@Injectable()
export class HandoffsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly policies: PolicyService,
    private readonly config: ConfigService,
  ) {}

  // El código nunca se guarda en claro: HMAC con clave del servidor, ligado al id del traspaso.
  private codeHash(handoffId: string, code: string) {
    return createHmac('sha256', this.config.getOrThrow<string>('HANDOFF_HMAC_SECRET'))
      .update(`${handoffId}:${code}`)
      .digest('hex');
  }

  // ---- Emisión (quien presenta)

  async issue(user: AuthUser, orderId: string, dto: IssueHandoffDto) {
    const rule = HANDOFF_RULES[dto.type];
    const order = await this.orders.forUser(user, orderId);
    this.assertStage(order, rule);
    this.assertParticipant(user, order, rule, rule.presenter);

    const policy = await this.policies.requireActive();
    const ttl = await this.policies.requireParam('handoffTtlMinutes', policy);
    const maxAttempts = await this.policies.requireParam('handoffMaxAttempts', policy);

    const id = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const qrToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + ttl * 60_000);

    await this.prisma.$transaction(async (tx) => {
      // Un solo código vigente por tipo: reemitir invalida el anterior.
      const live = await tx.handoff.findMany({
        where: { orderId, type: dto.type, status: { in: ['ACTIVE', 'PENDING'] } },
      });
      for (const h of live) {
        await tx.handoff.update({ where: { id: h.id }, data: { status: 'REVOKED' } });
        await this.audit(tx, h.id, 'REVOKED_BY_REISSUE', user);
      }
      const last = await tx.handoff.findFirst({
        where: { orderId, type: dto.type },
        orderBy: { generation: 'desc' },
      });
      await tx.handoff.create({
        data: {
          id,
          orderId,
          facilityId: order.facilityId,
          type: dto.type,
          status: 'ACTIVE',
          qrTokenHash: sha256(qrToken),
          codeHash: this.codeHash(id, code),
          generation: (last?.generation ?? 0) + 1,
          maxAttempts,
          activatedAt: new Date(),
          expiresAt,
          previousId: last?.id,
        },
      });
      await this.audit(tx, id, 'ISSUED', user);
    });
    // Única vez que el código y el token existen en claro.
    return { handoffId: id, type: dto.type, code, qrToken, expiresAt };
  }

  // ---- Verificación (quien recibe/valida)

  async verify(user: AuthUser, orderId: string, dto: VerifyHandoffDto) {
    if ((dto.code === undefined) === (dto.qrToken === undefined))
      throw new BadRequestException('Envía exactamente uno: code o qrToken.');
    const rule = HANDOFF_RULES[dto.type];
    const order = await this.orders.forUser(user, orderId);
    this.assertParticipant(user, order, rule, rule.verifier);
    if (order.version !== dto.expectedVersion)
      throw new ConflictException(
        `El pedido cambió (versión ${order.version}); recárgalo e intenta de nuevo.`,
      );
    this.assertStage(order, rule);

    const handoff = await this.prisma.handoff.findFirst({
      where: { orderId, type: dto.type, status: 'ACTIVE' },
      orderBy: { generation: 'desc' },
    });
    if (!handoff)
      throw new ConflictException('No hay un código vigente para este traspaso.');

    if (handoff.expiresAt && handoff.expiresAt <= new Date()) {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.handoff.updateMany({
          where: { id: handoff.id, status: 'ACTIVE' },
          data: { status: 'EXPIRED' },
        });
        if (count) await this.audit(tx, handoff.id, 'EXPIRED', user);
      });
      throw new GoneException('El código venció; solicita uno nuevo.');
    }

    // Reclama un intento de forma atómica y fuera de la transacción final: el intento fallido
    // debe quedar registrado aunque la operación termine en error.
    const claimed = await this.prisma.handoff.updateMany({
      where: { id: handoff.id, status: 'ACTIVE', attempts: { lt: handoff.maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (!claimed.count) {
      await this.lock(handoff.id, user);
      throw new HttpException('El código está bloqueado por demasiados intentos.', 423);
    }
    const attempts = handoff.attempts + 1;

    const ok =
      dto.code !== undefined
        ? safeEqual(this.codeHash(handoff.id, dto.code), handoff.codeHash)
        : safeEqual(sha256(dto.qrToken!), handoff.qrTokenHash);

    if (!ok) {
      await this.prisma.$transaction(async (tx) => {
        await this.audit(tx, handoff.id, 'FAILED_ATTEMPT', user);
      });
      if (attempts >= handoff.maxAttempts) {
        await this.lock(handoff.id, user);
        throw new HttpException('Código incorrecto. El traspaso quedó bloqueado.', 423);
      }
      throw new UnprocessableEntityException(
        `Código incorrecto. Intentos restantes: ${handoff.maxAttempts - attempts}.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.handoff.updateMany({
        where: { id: handoff.id, status: 'ACTIVE' },
        data: {
          status: 'USED',
          usedAt: new Date(),
          usedById: user.id,
          declaredCount: dto.declaredCount,
          receivedCount: dto.receivedCount,
          recipientName: dto.recipientName?.trim(),
          recipientRelationship: dto.recipientRelationship?.trim(),
          notes: dto.notes?.trim(),
        },
      });
      if (!count) throw new ConflictException('El código ya fue utilizado.');
      await this.audit(tx, handoff.id, 'VERIFIED', user);
      await this.orders.applyTransition(
        tx,
        order,
        rule.toStatus,
        user,
        `Custodia verificada (${dto.type})`,
      );
    });
    return this.orders.viewFor(user, orderId);
  }

  // ---- Consulta y revocación

  async list(user: AuthUser, orderId: string) {
    await this.orders.forUser(user, orderId);
    // Nunca se exponen hashes ni intentos internos al cliente o al chofer.
    return this.prisma.handoff.findMany({
      where: { orderId },
      orderBy: [{ type: 'asc' }, { generation: 'desc' }],
      select: {
        id: true,
        type: true,
        status: true,
        generation: true,
        expiresAt: true,
        usedAt: true,
        declaredCount: true,
        receivedCount: true,
      },
    });
  }

  async revoke(user: AuthUser, handoffId: string, dto: RevokeHandoffDto) {
    const handoff = await this.prisma.handoff.findUnique({ where: { id: handoffId } });
    if (!handoff) throw new NotFoundException('El traspaso no existe.');
    if (user.role === 'SUPERVISOR' && user.facilityId !== handoff.facilityId)
      throw new NotFoundException('El traspaso no existe.');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.handoff.updateMany({
        where: { id: handoffId, status: { in: ['ACTIVE', 'PENDING', 'LOCKED'] } },
        data: { status: 'REVOKED' },
      });
      if (!count) throw new ConflictException('El traspaso ya no puede revocarse.');
      await this.audit(tx, handoffId, 'REVOKED', user, dto.reason.trim());
    });
    return { id: handoffId, status: 'REVOKED' };
  }

  // ---- Utilidades

  private assertStage(order: FullOrder, rule: HandoffRule) {
    if (rule.mode && rule.mode !== order.mode)
      throw new ConflictException('Este traspaso no aplica al modo de entrega del pedido.');
    if (order.status !== rule.fromStatus)
      throw new ConflictException(
        `Este traspaso solo procede con el pedido en ${rule.fromStatus} (actual: ${order.status}).`,
      );
  }

  private assertParticipant(
    user: AuthUser,
    order: FullOrder,
    rule: HandoffRule,
    side: 'CLIENT' | 'DRIVER' | 'STAFF',
  ) {
    if (side === 'CLIENT') {
      if (user.role !== 'CLIENT' || order.customer.userId !== user.id)
        throw new ForbiddenException('Solo el cliente del pedido realiza esta acción.');
    } else if (side === 'DRIVER') {
      const leg = order.legs.find((l) => l.kind === rule.leg);
      if (user.role !== 'DRIVER' || leg?.driver?.userId !== user.id)
        throw new ForbiddenException('El pedido no está asignado a ti.');
    } else if (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR') {
      throw new ForbiddenException('Solo el personal de la sede realiza esta acción.');
    }
  }

  private async lock(handoffId: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.handoff.updateMany({
        where: { id: handoffId, status: 'ACTIVE' },
        data: { status: 'LOCKED' },
      });
      if (count) await this.audit(tx, handoffId, 'LOCKED', user);
    });
  }

  private audit(
    tx: Tx,
    handoffId: string,
    action: string,
    user: AuthUser,
    reason?: string,
  ) {
    return tx.handoffAudit.create({
      data: { handoffId, action, actorId: user.id, actorRole: user.role, reason },
    });
  }
}
