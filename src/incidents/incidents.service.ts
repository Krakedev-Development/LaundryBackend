import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import type { IncidentStatus, OrderStatus, Prisma } from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateIncidentDto, SetIncidentStatusDto } from './dto/incidents.dto';

type Tx = Prisma.TransactionClient;
// Tope de filas por consulta mientras los listados no tengan paginación.
const LIST_LIMIT = 200;
const isStaff = (u: AuthUser) => u.role === 'ADMIN' || u.role === 'SUPERVISOR';

// Estados en los que una incidencia puede retener el pedido (pausar su flujo).
const NOT_HOLDABLE: readonly OrderStatus[] = [
  'PAYMENT_PENDING',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'INCIDENT',
];

const NEXT: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN: ['IN_REVIEW', 'RESOLVED'],
  IN_REVIEW: ['RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
  ) {}

  // Cualquier participante del pedido reporta; solo chofer y personal pueden retenerlo.
  async create(user: AuthUser, dto: CreateIncidentDto) {
    const order = await this.orders.forUser(user, dto.orderId);
    if (dto.holdOrder && user.role === 'CLIENT')
      throw new ForbiddenException('Solo el chofer o el personal pueden retener un pedido.');
    if (dto.holdOrder && NOT_HOLDABLE.includes(order.status))
      throw new ConflictException(`Un pedido en ${order.status} no puede retenerse.`);

    const driver =
      user.role === 'DRIVER'
        ? await this.prisma.driver.findUnique({ where: { userId: user.id } })
        : null;

    return this.prisma.$transaction(async (tx) => {
      const incident = await tx.incident.create({
        data: {
          orderId: order.id,
          driverId: driver?.id,
          type: dto.type.trim(),
          severity: dto.severity,
          description: dto.description.trim(),
          evidenceRefs: dto.evidenceRefs ?? [],
          previousStatus: dto.holdOrder ? order.status : null,
          createdById: user.id,
        },
      });
      if (dto.holdOrder) {
        const { count } = await tx.order.updateMany({
          where: { id: order.id, status: order.status },
          data: { status: 'INCIDENT', version: { increment: 1 } },
        });
        if (!count) throw new ConflictException('El pedido cambió; intenta de nuevo.');
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            status: 'INCIDENT',
            title: 'Pedido retenido por incidencia',
            description: dto.type.trim(),
            actorId: user.id,
            actorRole: user.role,
          },
        });
        await this.notifications.notify(tx, order.customerId, {
          orderId: order.id,
          category: 'INCIDENT',
          title: 'Incidencia en tu pedido',
          body: 'Detectamos un inconveniente y lo estamos revisando.',
        });
      }
      return incident;
    });
  }

  async list(user: AuthUser, q: { status?: string; orderId?: string }) {
    const statuses: IncidentStatus[] = ['OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED'];
    if (q.status && !statuses.includes(q.status as IncidentStatus))
      throw new BadRequestException('Estado desconocido.');
    const where: Prisma.IncidentWhereInput = {
      ...(q.status ? { status: q.status as IncidentStatus } : {}),
      ...(q.orderId ? { orderId: q.orderId } : {}),
    };
    if (user.role === 'SUPERVISOR')
      where.order = { facilityId: user.facilityId ?? '00000000-0000-0000-0000-000000000000' };
    else if (!isStaff(user)) where.createdById = user.id;
    return this.prisma.incident.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: LIST_LIMIT,
    });
  }

  async setStatus(user: AuthUser, id: string, dto: SetIncidentStatusDto) {
    const incident = await this.prisma.incident.findUnique({
      where: { id },
      include: { order: true },
    });
    if (
      !incident ||
      (user.role === 'SUPERVISOR' && incident.order.facilityId !== user.facilityId)
    )
      throw new NotFoundException('La incidencia no existe.');
    if (!NEXT[incident.status].includes(dto.status))
      throw new ConflictException(
        `No se puede pasar de ${incident.status} a ${dto.status}.`,
      );
    if (dto.status === 'RESOLVED' && !dto.resolution?.trim())
      throw new BadRequestException('Describe la resolución.');

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.incident.updateMany({
        where: { id, status: incident.status },
        data: {
          status: dto.status,
          resolution: dto.resolution?.trim() ?? undefined,
          resolvedAt: dto.status === 'RESOLVED' ? new Date() : undefined,
        },
      });
      if (!count) throw new ConflictException('La incidencia cambió; intenta de nuevo.');
      if (dto.status === 'RESOLVED' && incident.previousStatus)
        await this.releaseOrder(tx, incident.order, incident.previousStatus, user);
      return tx.incident.findUniqueOrThrow({ where: { id } });
    });
  }

  // Devuelve el pedido al estado en que estaba cuando se retuvo.
  private async releaseOrder(
    tx: Tx,
    order: { id: string; customerId: string },
    previous: OrderStatus,
    user: AuthUser,
  ) {
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: 'INCIDENT' },
      data: { status: previous, version: { increment: 1 } },
    });
    if (!count) return;
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        status: previous,
        title: 'Incidencia resuelta: el pedido continúa',
        actorId: user.id,
        actorRole: user.role,
      },
    });
    await this.notifications.notify(tx, order.customerId, {
      orderId: order.id,
      category: 'INCIDENT',
      title: 'Incidencia resuelta',
      body: 'Resolvimos el inconveniente y tu pedido continúa.',
    });
  }
}
