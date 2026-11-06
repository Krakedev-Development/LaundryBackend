import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { CustomersService } from '../customers/customers.service';
import type { OrderStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = Pick<PrismaService, 'notification'> | Prisma.TransactionClient;

export interface NotifyInput {
  orderId?: string;
  category: string;
  title: string;
  body: string;
}

// Textos al cliente por estado del pedido. Solo los hitos que le importan generan aviso.
const STATUS_COPY: Partial<Record<OrderStatus, { title: string; body: string }>> = {
  CONFIRMED: { title: 'Pedido confirmado', body: 'Recibimos tu pago y tu pedido está confirmado.' },
  PICKUP_ASSIGNED: { title: 'Chofer asignado', body: 'Ya hay un chofer asignado a tu recogida.' },
  HEADING_TO_PICKUP: { title: 'Chofer en camino', body: 'Tu chofer va hacia tu dirección.' },
  PICKED_UP: { title: 'Ropa recogida', body: 'Recogimos tu ropa y va hacia la sede.' },
  AT_FACILITY: { title: 'Ropa en la sede', body: 'Tu ropa llegó a la sede.' },
  CUSTOMER_APPROVAL_PENDING: {
    title: 'Necesitamos tu aprobación',
    body: 'Hay un ajuste de precio que debes aprobar o rechazar.',
  },
  IN_PROCESS: { title: 'Tu ropa está en proceso', body: 'Estamos lavando tu ropa.' },
  READY_FOR_DELIVERY: { title: 'Pedido listo', body: 'Tu pedido está listo para entrega.' },
  READY_FOR_PICKUP: { title: 'Pedido listo', body: 'Tu pedido está listo para retirar en la sede.' },
  OUT_FOR_DELIVERY: { title: 'Pedido en camino', body: 'Tu pedido va hacia tu dirección.' },
  DELIVERED: { title: 'Pedido entregado', body: 'Tu pedido fue entregado.' },
  COMPLETED: { title: 'Pedido completado', body: 'Gracias por usar el servicio.' },
  CANCELLED: { title: 'Pedido cancelado', body: 'Tu pedido fue cancelado.' },
};

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
  ) {}

  notify(db: Db, customerId: string, n: NotifyInput) {
    return db.notification.create({ data: { customerId, ...n } });
  }

  // Aviso por cambio de estado; los estados sin texto no notifican.
  async orderStatus(
    tx: Prisma.TransactionClient,
    order: { id: string; customerId: string },
    status: OrderStatus,
  ) {
    const copy = STATUS_COPY[status];
    if (copy)
      await this.notify(tx, order.customerId, {
        orderId: order.id,
        category: 'ORDER_STATUS',
        ...copy,
      });
  }

  async list(user: AuthUser, q: { unread?: string; page?: number; pageSize?: number }) {
    const customer = await this.customers.customerOf(user);
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 20, 100);
    const where: Prisma.NotificationWhereInput = {
      customerId: customer.id,
      ...(q.unread === 'true' ? { readAt: null } : {}),
    };
    const [total, unread, data] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { customerId: customer.id, readAt: null } }),
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
    const customer = await this.customers.customerOf(user);
    const { count } = await this.prisma.notification.updateMany({
      where: { id, customerId: customer.id, readAt: null },
      data: { readAt: new Date() },
    });
    if (!count) {
      const exists = await this.prisma.notification.findFirst({
        where: { id, customerId: customer.id },
      });
      if (!exists) throw new NotFoundException('La notificación no existe.');
    }
    return { id, read: true };
  }

  async markAllRead(user: AuthUser) {
    const customer = await this.customers.customerOf(user);
    const { count } = await this.prisma.notification.updateMany({
      where: { customerId: customer.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }
}
