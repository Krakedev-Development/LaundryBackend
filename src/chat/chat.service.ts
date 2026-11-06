import { ConflictException, Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
  ) {}

  // El hilo es del pedido: lo ven el cliente, el chofer asignado y el personal de la sede.
  async send(user: AuthUser, orderId: string, text: string) {
    const order = await this.orders.forUser(user, orderId);
    if (order.status === 'CANCELLED' || order.status === 'COMPLETED')
      throw new ConflictException('El pedido ya está cerrado; no admite mensajes.');
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.chatMessage.create({
        data: { orderId, senderId: user.id, senderRole: user.role, text: text.trim() },
      });
      // El cliente recibe aviso cuando le escribe el chofer o el personal.
      if (user.role !== 'CLIENT')
        await this.notifications.notify(tx, order.customerId, {
          orderId,
          category: 'CHAT',
          title: 'Nuevo mensaje sobre tu pedido',
          body: message.text.slice(0, 120),
        });
      return message;
    });
  }

  // Paginación por cursor temporal: devuelve mensajes posteriores a `after`, en orden.
  async list(user: AuthUser, orderId: string, after?: string, limit?: number) {
    await this.orders.forUser(user, orderId);
    return this.prisma.chatMessage.findMany({
      where: { orderId, ...(after ? { createdAt: { gt: new Date(after) } } : {}) },
      orderBy: { createdAt: 'asc' },
      take: Math.min(limit ?? 50, 100),
    });
  }
}
