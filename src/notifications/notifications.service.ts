import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { CustomersService } from '../customers/customers.service';
import type {
  DeviceAppType,
  DevicePlatform,
  OrderStatus,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  TrackingGateway,
  type NotificationBroadcast,
} from '../tracking/tracking.gateway';
import { PushService } from './push.service';

type Db = Pick<PrismaService, 'notification'> | Prisma.TransactionClient;

export interface NotifyInput {
  orderId?: string;
  category: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channelId?: string;
}

// Textos al cliente por estado del pedido. Solo los hitos que le importan generan aviso.
const STATUS_COPY: Partial<Record<OrderStatus, { title: string; body: string }>> = {
  CONFIRMED: { title: 'Pedido confirmado', body: 'Recibimos tu pago y tu pedido está confirmado.' },
  PICKUP_ASSIGNED: { title: 'Chofer asignado', body: 'Ya hay un chofer asignado a tu recogida.' },
  HEADING_TO_PICKUP: { title: 'Chofer en camino', body: 'Tu chofer va hacia tu dirección.' },
  ARRIVED_FOR_PICKUP: { title: 'Chofer en tu puerta', body: 'El chofer llegó al punto de recogida.' },
  PICKED_UP: { title: 'Ropa recogida', body: 'Recogimos tu ropa y va hacia la sede.' },
  AT_FACILITY: { title: 'Ropa en la sede', body: 'Tu ropa llegó a la sede.' },
  CUSTOMER_APPROVAL_PENDING: {
    title: 'Necesitamos tu aprobación',
    body: 'Hay un ajuste de precio que debes aprobar o rechazar.',
  },
  IN_PROCESS: { title: 'Tu ropa está en proceso', body: 'Estamos lavando tu ropa.' },
  READY_FOR_DELIVERY: { title: 'Pedido listo', body: 'Tu pedido está listo para entrega.' },
  READY_FOR_PICKUP: { title: 'Pedido listo', body: 'Tu pedido está listo para retirar en la sede.' },
  DELIVERY_ASSIGNED: { title: 'Chofer asignado a entrega', body: 'Tu pedido ya tiene chofer asignado para la entrega.' },
  OUT_FOR_DELIVERY: { title: 'Pedido en camino', body: 'Tu pedido va hacia tu dirección.' },
  ARRIVED_FOR_DELIVERY: { title: 'Chofer en tu puerta', body: 'El chofer llegó con tu pedido.' },
  DELIVERED: { title: 'Pedido entregado', body: 'Tu pedido fue entregado.' },
  COMPLETED: { title: 'Pedido completado', body: 'Gracias por usar el servicio.' },
  CANCELLED: { title: 'Pedido cancelado', body: 'Tu pedido fue cancelado.' },
};

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly push: PushService,
    @Optional() private readonly trackingGateway?: TrackingGateway,
  ) {}

  async notify(db: Db, customerId: string, n: NotifyInput) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { userId: true },
    });
    const userId = customer?.userId ?? null;
    const created = await db.notification.create({
      data: {
        customerId,
        userId,
        orderId: n.orderId,
        category: n.category,
        title: n.title,
        body: n.body,
        ...(n.data ? { data: n.data as Prisma.InputJsonValue } : {}),
      },
    });
    if (userId) {
      this.dispatchRealtimeAndPush(userId, created, n);
    }
    return created;
  }

  async notifyUser(
    db: Db,
    userId: string,
    n: NotifyInput & { customerId?: string | null },
  ) {
    const created = await db.notification.create({
      data: {
        userId,
        customerId: n.customerId ?? null,
        orderId: n.orderId,
        category: n.category,
        title: n.title,
        body: n.body,
        ...(n.data ? { data: n.data as Prisma.InputJsonValue } : {}),
      },
    });
    this.dispatchRealtimeAndPush(userId, created, n);
    return created;
  }

  // Aviso por cambio de estado; los estados sin texto no notifican.
  async orderStatus(
    tx: Prisma.TransactionClient,
    order: { id: string; customerId: string },
    status: OrderStatus,
  ) {
    const copy = STATUS_COPY[status];
    if (copy) {
      await this.notify(tx, order.customerId, {
        orderId: order.id,
        category: 'ORDER_STATUS',
        data: { type: 'ORDER_STATUS', orderId: order.id, status },
        channelId: 'orders',
        ...copy,
      });
    }
  }

  async list(
    user: AuthUser,
    q: { unread?: string; page?: number; pageSize?: number },
  ) {
    const owner = await this.ownerWhere(user);
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 20, 100);
    const where: Prisma.NotificationWhereInput = {
      ...owner,
      ...(q.unread === 'true' ? { readAt: null } : {}),
    };
    const [total, unread, data] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...owner, readAt: null } }),
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { page, pageSize, total, unread, data };
  }

  async markRead(user: AuthUser, id: string) {
    const owner = await this.ownerWhere(user);
    const { count } = await this.prisma.notification.updateMany({
      where: { ...owner, id, readAt: null },
      data: { readAt: new Date() },
    });
    if (!count) {
      const exists = await this.prisma.notification.findFirst({
        where: { ...owner, id },
      });
      if (!exists) throw new NotFoundException('La notificación no existe.');
    }
    return { id, read: true };
  }

  async markAllRead(user: AuthUser) {
    const owner = await this.ownerWhere(user);
    const { count } = await this.prisma.notification.updateMany({
      where: { ...owner, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }

  async registerDevice(
    user: AuthUser,
    dto: {
      token: string;
      platform: DevicePlatform;
      appType: DeviceAppType;
      deviceName?: string;
    },
  ) {
    const token = dto.token.trim();
    const record = await this.prisma.deviceToken.upsert({
      where: { token },
      update: {
        userId: user.id,
        platform: dto.platform,
        appType: dto.appType,
        deviceName: dto.deviceName?.trim() || null,
        active: true,
        lastSeenAt: new Date(),
      },
      create: {
        userId: user.id,
        token,
        platform: dto.platform,
        appType: dto.appType,
        deviceName: dto.deviceName?.trim() || null,
        active: true,
      },
    });
    return {
      id: record.id,
      token: record.token,
      platform: record.platform,
      appType: record.appType,
      active: record.active,
    };
  }

  async unregisterDevice(user: AuthUser, token: string) {
    const clean = token.trim();
    const { count } = await this.prisma.deviceToken.updateMany({
      where: { token: clean, userId: user.id, active: true },
      data: { active: false },
    });
    return { unregistered: count > 0 };
  }

  private async ownerWhere(
    user: AuthUser,
  ): Promise<Prisma.NotificationWhereInput> {
    if (user.role === 'CLIENT') {
      const customer = await this.customers.customerOf(user).catch(() => null);
      if (customer) {
        return {
          OR: [{ userId: user.id }, { customerId: customer.id }],
        };
      }
    }
    return { userId: user.id };
  }

  private dispatchRealtimeAndPush(
    userId: string,
    row: {
      id: string;
      userId: string | null;
      customerId: string | null;
      orderId: string | null;
      category: string;
      title: string;
      body: string;
      data: Prisma.JsonValue | null;
      readAt: Date | null;
      createdAt: Date;
    },
    n: NotifyInput,
  ): void {
    const wire: NotificationBroadcast = {
      id: row.id,
      userId: row.userId,
      customerId: row.customerId,
      orderId: row.orderId,
      category: row.category,
      title: row.title,
      body: row.body,
      data: row.data ?? null,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
    this.trackingGateway?.emitNotification(userId, wire);

    const pushData: Record<string, unknown> = {
      ...(n.data ?? {}),
      notificationId: row.id,
      category: row.category,
      ...(row.orderId ? { orderId: row.orderId } : {}),
    };
    void this.push.sendToUsers([userId], {
      title: n.title,
      body: n.body,
      data: pushData,
      channelId: n.channelId ?? 'orders',
    });
  }
}
