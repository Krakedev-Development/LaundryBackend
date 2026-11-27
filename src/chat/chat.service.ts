import { ConflictException, Injectable, Optional } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingGateway } from '../tracking/tracking.gateway';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly trackingGateway?: TrackingGateway,
  ) {}

  // El hilo único es del pedido: participan el cliente, el chofer asignado y el personal web.
  async send(user: AuthUser, orderId: string, text: string) {
    const order = await this.orders.forUser(user, orderId);
    if (order.status === 'CANCELLED' || order.status === 'COMPLETED') {
      throw new ConflictException(
        'El pedido ya está cerrado; no admite mensajes.',
      );
    }

    const driverUserIds = Array.from(
      new Set(
        order.legs
          .map((l) => l.driver?.userId)
          .filter((uid): uid is string => typeof uid === 'string' && uid.length > 0),
      ),
    );
    const customerUserId = order.customer.userId;

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.chatMessage.create({
        data: {
          orderId,
          senderId: user.id,
          senderRole: user.role,
          text: text.trim(),
        },
        include: {
          sender: { select: { name: true } },
        },
      });
      const senderName = created.sender?.name ?? user.role;
      const chatData = {
        type: 'CHAT',
        orderId,
        orderNumber: order.number,
      };

      if (user.role !== 'CLIENT') {
        await this.notifications.notify(tx, order.customerId, {
          orderId,
          category: 'CHAT',
          title: 'Nuevo mensaje sobre tu pedido',
          body: created.text.slice(0, 120),
          data: chatData,
          channelId: 'chat',
        });
      }

      for (const driverUserId of driverUserIds) {
        if (driverUserId === user.id) continue;
        await this.notifications.notifyUser(tx, driverUserId, {
          orderId,
          category: 'CHAT',
          title: `Nuevo mensaje · Pedido #${order.number}`,
          body: `${senderName}: ${created.text.slice(0, 100)}`,
          data: chatData,
          channelId: 'chat',
        });
      }

      if (user.role === 'CLIENT' || user.role === 'DRIVER') {
        const staffUsers = await tx.user.findMany({
          where: {
            status: 'ACTIVE',
            id: { not: user.id },
            OR: [
              { role: 'ADMIN' },
              { role: 'SUPERVISOR', facilityId: order.facilityId },
            ],
          },
          select: { id: true },
        });
        for (const staff of staffUsers) {
          await this.notifications.notifyUser(tx, staff.id, {
            orderId,
            category: 'CHAT',
            title: `Nuevo mensaje · Pedido #${order.number}`,
            body: `${senderName}: ${created.text.slice(0, 100)}`,
            data: chatData,
            channelId: 'chat',
          });
        }
      }

      return created;
    });

    const wire = {
      id: message.id,
      orderId: message.orderId,
      senderId: message.senderId,
      senderName: message.sender?.name ?? user.role,
      senderRole: message.senderRole,
      text: message.text,
      createdAt: message.createdAt,
    };

    this.trackingGateway?.emitChatMessage(
      {
        ...wire,
        orderNumber: order.number,
        facilityId: order.facilityId,
        createdAt: message.createdAt.toISOString(),
      },
      {
        customerUserId,
        driverUserIds,
        facilityId: order.facilityId,
      },
    );

    return wire;
  }

  // Paginación por cursor temporal: devuelve mensajes posteriores a `after`, en orden.
  async list(user: AuthUser, orderId: string, after?: string, limit?: number) {
    await this.orders.forUser(user, orderId);
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        orderId,
        ...(after ? { createdAt: { gt: new Date(after) } } : {}),
      },
      include: {
        sender: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(limit ?? 50, 100),
    });
    return rows.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      senderId: row.senderId,
      senderName: row.sender?.name ?? row.senderRole,
      senderRole: row.senderRole,
      text: row.text,
      createdAt: row.createdAt,
    }));
  }
}
