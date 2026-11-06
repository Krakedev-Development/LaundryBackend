import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { CustomersService } from '../customers/customers.service';
import type { Prisma } from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;
const isStaff = (u: AuthUser) => u.role === 'ADMIN' || u.role === 'SUPERVISOR';

@Injectable()
export class PointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly notifications: NotificationsService,
  ) {}

  async balance(db: Pick<PrismaService, 'pointsLedgerEntry'> | Tx, customerId: string) {
    const { _sum } = await db.pointsLedgerEntry.aggregate({
      where: { customerId },
      _sum: { points: true },
    });
    return _sum.points ?? 0;
  }

  // Suma puntos al completarse un pedido, con la política congelada al crearlo. Sin tasa
  // configurada (programa de puntos no definido) no se acumula nada. Es idempotente por pedido.
  async accrueForOrder(
    tx: Tx,
    order: { id: string; customerId: string; total: Prisma.Decimal; policyVersion: number },
  ) {
    const policy = await tx.businessPolicy.findUnique({
      where: { version: order.policyVersion },
    });
    const rate = policy?.pointsPerCurrencyUnit;
    if (!rate) return 0;
    if (await tx.pointsLedgerEntry.count({ where: { orderId: order.id, reason: 'ORDER_COMPLETED' } }))
      return 0;
    const points = Math.floor(order.total.mul(rate).toNumber());
    if (points <= 0) return 0;
    await tx.pointsLedgerEntry.create({
      data: {
        customerId: order.customerId,
        orderId: order.id,
        points,
        reason: 'ORDER_COMPLETED',
      },
    });
    await this.notifications.notify(tx, order.customerId, {
      orderId: order.id,
      category: 'POINTS',
      title: 'Sumaste puntos',
      body: `Ganaste ${points} puntos por tu pedido.`,
    });
    return points;
  }

  // ---- Cliente

  async mine(user: AuthUser) {
    const customer = await this.customers.customerOf(user);
    const [balance, entries] = await Promise.all([
      this.balance(this.prisma, customer.id),
      this.prisma.pointsLedgerEntry.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    return { balance, entries };
  }

  // Reserva los puntos al solicitar; si el personal rechaza, se devuelven.
  async redeem(user: AuthUser, rewardId: string) {
    const customer = await this.customers.customerOf(user);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customer.id}::uuid FOR UPDATE`;
      const reward = await tx.reward.findUnique({ where: { id: rewardId } });
      if (!reward || !reward.active) throw new NotFoundException('La recompensa no existe.');
      if ((await this.balance(tx, customer.id)) < reward.pointsCost)
        throw new ConflictException('No tienes puntos suficientes.');
      const redemption = await tx.rewardRedemption.create({
        data: { customerId: customer.id, rewardId, pointsCost: reward.pointsCost },
      });
      await tx.pointsLedgerEntry.create({
        data: {
          customerId: customer.id,
          points: -reward.pointsCost,
          reason: `REDEMPTION:${redemption.id}`,
        },
      });
      return redemption;
    });
  }

  async redemptions(user: AuthUser, status?: string) {
    const parsed = status as 'PENDING' | 'APPROVED' | 'REJECTED' | undefined;
    if (parsed && !['PENDING', 'APPROVED', 'REJECTED'].includes(parsed))
      throw new BadRequestException('Estado desconocido.');
    if (isStaff(user))
      return this.prisma.rewardRedemption.findMany({
        where: parsed ? { status: parsed } : {},
        include: { reward: { select: { title: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
    const customer = await this.customers.customerOf(user);
    return this.prisma.rewardRedemption.findMany({
      where: { customerId: customer.id, ...(parsed ? { status: parsed } : {}) },
      include: { reward: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---- Personal

  async review(
    actor: AuthUser,
    id: string,
    dto: { approve: boolean; reason?: string },
  ) {
    if (!dto.approve && !dto.reason?.trim())
      throw new BadRequestException('Indica el motivo del rechazo.');
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rewardRedemption.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: dto.approve ? 'APPROVED' : 'REJECTED',
          reviewedById: actor.id,
          reviewedAt: new Date(),
          reviewReason: dto.reason?.trim(),
        },
      });
      if (!count) throw new ConflictException('La solicitud no existe o ya fue revisada.');
      const redemption = await tx.rewardRedemption.findUniqueOrThrow({
        where: { id },
        include: { reward: { select: { title: true } } },
      });
      if (!dto.approve)
        await tx.pointsLedgerEntry.create({
          data: {
            customerId: redemption.customerId,
            points: redemption.pointsCost,
            reason: `REDEMPTION_REVERSED:${id}`,
          },
        });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: dto.approve ? 'REDEMPTION_APPROVED' : 'REDEMPTION_REJECTED',
          entity: 'RewardRedemption',
          entityId: id,
          reason: dto.reason?.trim(),
        },
      });
      await this.notifications.notify(tx, redemption.customerId, {
        category: 'REDEMPTION',
        title: dto.approve ? 'Canje aprobado' : 'Canje rechazado',
        body: dto.approve
          ? `Tu canje de "${redemption.reward.title}" fue aprobado.`
          : `Tu canje de "${redemption.reward.title}" fue rechazado y recuperaste tus puntos.`,
      });
      return redemption;
    });
  }
}
