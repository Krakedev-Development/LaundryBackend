import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { toPublic } from '../auth/auth.service';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateDriverDto, CreateStaffDto } from './dto/users.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async createDriver(actor: AuthUser, dto: CreateDriverDto) {
    const email = dto.email.trim().toLowerCase();
    await this.assertEmailFree(email);
    const facility = await this.prisma.facility.findUnique({
      where: { id: dto.facilityId },
    });
    if (!facility || !facility.active)
      throw new NotFoundException('La sede no existe o está inactiva.');
    const passwordHash = await argon2.hash(dto.temporaryPassword);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name: dto.name.trim(),
          phone: dto.phone.trim(),
          role: 'DRIVER',
          status: 'PASSWORD_CHANGE_REQUIRED',
          passwordHash,
          facilityId: facility.id,
          driver: {
            create: {
              facilityId: facility.id,
              vehicle: dto.vehicle?.trim(),
              plate: dto.plate?.trim(),
            },
          },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'DRIVER_CREATED',
          entity: 'User',
          entityId: user.id,
        },
      });
      return toPublic(user);
    });
  }

  async createStaff(actor: AuthUser, dto: CreateStaffDto) {
    if (dto.role === 'SUPERVISOR' && !dto.facilityId)
      throw new BadRequestException('El supervisor requiere una sede.');
    if (dto.role === 'ADMIN' && dto.facilityId)
      throw new BadRequestException('El administrador no se limita a una sede.');
    const email = dto.email.trim().toLowerCase();
    await this.assertEmailFree(email);
    if (dto.facilityId) {
      const facility = await this.prisma.facility.findUnique({
        where: { id: dto.facilityId },
      });
      if (!facility) throw new NotFoundException('La sede no existe.');
    }
    const passwordHash = await argon2.hash(dto.temporaryPassword);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name: dto.name.trim(),
          phone: dto.phone.trim(),
          role: dto.role,
          status: 'PASSWORD_CHANGE_REQUIRED',
          passwordHash,
          facilityId: dto.facilityId ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: `${dto.role}_CREATED`,
          entity: 'User',
          entityId: user.id,
        },
      });
      return toPublic(user);
    });
  }

  // Personal de la web (supervisores y administradores) con su sede y último ingreso.
  async listStaff() {
    const users = await this.prisma.user.findMany({
      where: { role: { in: ['SUPERVISOR', 'ADMIN'] } },
      orderBy: [{ role: 'desc' }, { createdAt: 'desc' }],
      include: { facility: { select: { id: true, name: true } } },
    });
    const logins = await this.prisma.auditLog.groupBy({
      by: ['actorId'],
      where: { action: 'LOGIN', actorId: { in: users.map((u) => u.id) } },
      _max: { createdAt: true },
    });
    const lastLogin = new Map(logins.map((l) => [l.actorId, l._max.createdAt]));
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role,
      status: u.status,
      facility: u.facility,
      createdAt: u.createdAt,
      lastLoginAt: lastLogin.get(u.id) ?? null,
    }));
  }

  // Suspender cierra todas sus sesiones; reactivar devuelve el acceso.
  async setStatus(
    actor: AuthUser,
    id: string,
    dto: { status: 'ACTIVE' | 'SUSPENDED'; reason?: string },
  ) {
    const user = await this.manageable(actor, id);
    if (dto.status === 'SUSPENDED' && user.status === 'SUSPENDED')
      throw new ConflictException('La cuenta ya está suspendida.');
    if (dto.status === 'ACTIVE' && user.status !== 'SUSPENDED')
      throw new ConflictException('La cuenta no está suspendida.');
    // Al reactivar se restaura el estado previo: quien no había cambiado su contraseña
    // temporal sigue obligado a hacerlo.
    let next: 'ACTIVE' | 'SUSPENDED' | 'PASSWORD_CHANGE_REQUIRED' = dto.status;
    if (dto.status === 'ACTIVE') {
      const suspension = await this.prisma.auditLog.findFirst({
        where: { entity: 'User', entityId: id, action: 'USER_SUSPENDED' },
        orderBy: { createdAt: 'desc' },
      });
      const previous = (suspension?.before as { status?: string } | null)?.status;
      if (previous === 'PASSWORD_CHANGE_REQUIRED') next = previous;
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { status: next },
      });
      if (dto.status === 'SUSPENDED')
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: dto.status === 'SUSPENDED' ? 'USER_SUSPENDED' : 'USER_REACTIVATED',
          entity: 'User',
          entityId: id,
          reason: dto.reason?.trim() || null,
          before: { status: user.status },
          after: { status: next },
        },
      });
      return toPublic(updated);
    });
  }

  // Nueva contraseña temporal: la cuenta debe cambiarla en el siguiente ingreso.
  async resetPassword(actor: AuthUser, id: string, dto: { temporaryPassword: string }) {
    const user = await this.manageable(actor, id);
    if (user.status === 'SUSPENDED')
      throw new ConflictException('Reactiva la cuenta antes de restablecer su contraseña.');
    const passwordHash = await argon2.hash(dto.temporaryPassword);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { passwordHash, status: 'PASSWORD_CHANGE_REQUIRED' },
      });
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'PASSWORD_RESET',
          entity: 'User',
          entityId: id,
        },
      });
      return toPublic(updated);
    });
  }

  // Actividad de una cuenta del personal o chofer: une el registro de auditoría, los
  // eventos de pedidos y la auditoría de custodia, del más reciente al más antiguo.
  async activity(
    id: string,
    query: { from?: string; to?: string; page?: number; pageSize?: number },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { facility: { select: { id: true, name: true } } },
    });
    if (!user || user.role === 'CLIENT') throw new NotFoundException('La cuenta no existe.');

    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * DAY_MS);
    if (from > to)
      throw new BadRequestException('La fecha inicial debe ser anterior a la final.');
    if (to.getTime() - from.getTime() > 366 * DAY_MS)
      throw new BadRequestException('El rango máximo es de un año.');
    // Paginación sobre las tres fuentes unidas: para la página N basta con los
    // N × tamaño registros más recientes de cada fuente; luego se ordena y se recorta.
    const pageSize = query.pageSize ?? 10;
    const page = query.page ?? 1;
    const skip = (page - 1) * pageSize;
    const take = skip + pageSize;
    const createdAt = { gte: from, lte: to };

    const [audits, orderEvents, handoffEvents, logins, lastLogin, auditTotal, orderTotal, handoffTotal] =
      await Promise.all([
        this.prisma.auditLog.findMany({
          where: { actorId: id, createdAt },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        }),
        this.prisma.orderEvent.findMany({
          where: { actorId: id, createdAt },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          include: { order: { select: { number: true } } },
        }),
        this.prisma.handoffAudit.findMany({
          where: { actorId: id, createdAt },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          include: { handoff: { select: { type: true, order: { select: { id: true, number: true } } } } },
        }),
        this.prisma.auditLog.count({ where: { actorId: id, action: 'LOGIN', createdAt } }),
        this.prisma.auditLog.findFirst({
          where: { actorId: id, action: 'LOGIN' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        this.prisma.auditLog.count({ where: { actorId: id, createdAt } }),
        this.prisma.orderEvent.count({ where: { actorId: id, createdAt } }),
        this.prisma.handoffAudit.count({ where: { actorId: id, createdAt } }),
      ]);

    const merged = [
      ...audits.map((a) => ({
        id: a.id,
        source: 'AUDIT' as const,
        action: a.action,
        entity: a.entity,
        entityId: a.entityId,
        orderNumber: null as number | null,
        detail: a.reason,
        createdAt: a.createdAt,
      })),
      ...orderEvents.map((e) => ({
        id: e.id,
        source: 'ORDER' as const,
        action: `ORDER_${e.status}`,
        entity: 'Order',
        entityId: e.orderId,
        orderNumber: e.order.number,
        detail: e.title,
        createdAt: e.createdAt,
      })),
      ...handoffEvents.map((h) => ({
        id: h.id,
        source: 'HANDOFF' as const,
        action: `HANDOFF_${h.action}`,
        entity: 'Order',
        entityId: h.handoff.order.id,
        orderNumber: h.handoff.order.number,
        detail: h.reason ?? h.handoff.type,
        createdAt: h.createdAt,
      })),
    ].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    const items = merged.slice(skip, take);

    const total = auditTotal + orderTotal + handoffTotal;
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        facility: user.facility,
      },
      range: { from, to },
      summary: {
        logins,
        actions: total - logins,
        lastLoginAt: lastLogin?.createdAt ?? null,
        lastActivityAt: merged[0]?.createdAt ?? null,
      },
      items,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  // Solo cuentas de personal y choferes, y nunca la propia.
  private async manageable(actor: AuthUser, id: string) {
    if (actor.id === id)
      throw new BadRequestException('No puedes modificar tu propia cuenta.');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.role === 'CLIENT')
      throw new NotFoundException('La cuenta no existe.');
    return user;
  }

  private async assertEmailFree(email: string): Promise<void> {
    if (await this.prisma.user.findUnique({ where: { email } }))
      throw new ConflictException('El correo ya tiene una cuenta.');
  }
}
