import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { OrderStatus, UserRole } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CUSTOMER_LIVE_TRACKING_STATUSES,
  liveTrackingLegFor,
  validateDriverCoordinates,
  type LiveDriverLocation,
} from './tracking.constants';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userRole?: UserRole;
  facilityId?: string | null;
}

export interface DriverLocationUpdateMessage {
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  orderId?: string;
}

export interface OrderStatusBroadcast {
  orderId: string;
  orderNumber?: number;
  status: OrderStatus;
  activeLeg: 'INBOUND' | 'OUTBOUND' | null;
  customerUserId: string;
  driverUserIds?: string[];
  updatedAt: string;
}

export interface OrderEtaBroadcast {
  orderId: string;
  activeLeg: 'INBOUND' | 'OUTBOUND';
  etaMinutes: number;
  distanceMeters: number;
  durationSeconds: number;
  driverLocation?: {
    lat: number;
    lng: number;
    heading?: number;
    speed?: number;
    locationAt: string;
  };
  updatedAt: string;
}

@WebSocketGateway({
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
  pingInterval: 25_000,
  pingTimeout: 20_000,
  perMessageDeflate: { threshold: 256 },
  maxHttpBufferSize: 1e6,
})
export class TrackingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server?: Server;

  private readonly logger = new Logger(TrackingGateway.name);
  private readonly userSockets = new Map<string, Set<string>>();
  private readonly driverLocations = new Map<string, LiveDriverLocation>();
  private readonly locationWriteQueue = new Map<string, LiveDriverLocation>();
  private batchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(): void {
    this.logger.log('TrackingGateway WebSocket inicializado');
    if (!this.batchTimer) {
      this.batchTimer = setInterval(() => {
        void this.flushLocationWrites();
      }, 2_000);
      this.batchTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    const rawToken =
      (client.handshake.auth as { token?: unknown } | undefined)?.token ??
      client.handshake.query?.token;
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';

    if (!token) {
      client.emit('authentication_error', {
        success: false,
        error: 'Token de autenticación requerido',
      });
      client.disconnect(true);
      return;
    }

    try {
      const secret = this.config.getOrThrow<string>('JWT_ACCESS_SECRET');
      const payload = this.jwt.verify<{ sub: string }>(token, {
        secret,
        algorithms: ['HS256'],
      });
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true, status: true, facilityId: true },
      });
      if (!user || user.status === 'SUSPENDED') {
        client.emit('authentication_error', {
          success: false,
          error: 'Usuario no encontrado o suspendido',
        });
        client.disconnect(true);
        return;
      }

      client.userId = user.id;
      client.userRole = user.role;
      client.facilityId = user.facilityId;

      if (!this.userSockets.has(user.id)) {
        this.userSockets.set(user.id, new Set());
      }
      this.userSockets.get(user.id)!.add(client.id);

      if (user.role === 'ADMIN' || user.role === 'SUPERVISOR') {
        void client.join('admins');
      }

      client.emit('authenticated', { userId: user.id, role: user.role });
    } catch (error) {
      this.logger.warn(
        `Socket auth fallida para ${client.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      client.emit('authentication_error', {
        success: false,
        error: 'Token inválido o expirado',
      });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthenticatedSocket): void {
    if (!client.userId) return;
    const set = this.userSockets.get(client.userId);
    if (!set) return;
    set.delete(client.id);
    if (set.size === 0) {
      this.userSockets.delete(client.userId);
    }
  }

  @SubscribeMessage('order:subscribe')
  async handleOrderSubscribe(
    @MessageBody() data: { orderId?: string },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    const orderId = typeof data?.orderId === 'string' ? data.orderId.trim() : '';
    if (!orderId || !client.userId) {
      return { event: 'order:subscribed', data: { success: false } };
    }
    const allowed = await this.canUserSubscribeToOrder(client, orderId);
    if (!allowed) {
      return {
        event: 'order:subscribed',
        data: { success: false, error: 'Sin permiso para seguir esta orden' },
      };
    }
    await client.join(`order:${orderId}`);
    return { event: 'order:subscribed', data: { success: true, orderId } };
  }

  @SubscribeMessage('order:unsubscribe')
  async handleOrderUnsubscribe(
    @MessageBody() data: { orderId?: string },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    const orderId = typeof data?.orderId === 'string' ? data.orderId.trim() : '';
    if (orderId) {
      await client.leave(`order:${orderId}`);
    }
    return { event: 'order:unsubscribed', data: { success: true, orderId } };
  }

  @SubscribeMessage('driver:location:update')
  async handleDriverLocationUpdate(
    @MessageBody() data: DriverLocationUpdateMessage,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    if (!client.userId || client.userRole !== 'DRIVER') {
      return {
        event: 'driver:location:received',
        data: { success: false, error: 'Solo los choferes pueden enviar ubicación' },
      };
    }

    const coordError = validateDriverCoordinates(data?.lat, data?.lng);
    if (coordError) {
      return {
        event: 'driver:location:received',
        data: { success: false, error: coordError },
      };
    }

    const driver = await this.prisma.driver.findUnique({
      where: { userId: client.userId },
      select: { id: true },
    });
    if (!driver) {
      return {
        event: 'driver:location:received',
        data: { success: false, error: 'Perfil de chofer no encontrado' },
      };
    }

    const heading =
      typeof data.heading === 'number' && Number.isFinite(data.heading)
        ? data.heading
        : undefined;
    const speed =
      typeof data.speed === 'number' && Number.isFinite(data.speed)
        ? data.speed
        : undefined;

    const fix: LiveDriverLocation = {
      lat: data.lat,
      lng: data.lng,
      heading,
      speed,
      timestamp: Date.now(),
    };

    this.driverLocations.set(driver.id, fix);
    this.locationWriteQueue.set(driver.id, fix);

    await this.broadcastDriverLocationToTrackedOrders(driver.id, fix, data.orderId);
    return { event: 'driver:location:received', data: { success: true } };
  }

  /**
   * Llamado también desde DriversService.updateLocation (fallback REST) para mantener
   * sincronizados el caché en memoria y los clientes conectados por WebSocket.
   */
  async recordDriverLocationFromHttp(
    driverId: string,
    lat: number,
    lng: number,
    heading?: number,
    speed?: number,
  ): Promise<void> {
    if (validateDriverCoordinates(lat, lng)) return;
    const fix: LiveDriverLocation = {
      lat,
      lng,
      heading,
      speed,
      timestamp: Date.now(),
    };
    this.driverLocations.set(driverId, fix);
    await this.broadcastDriverLocationToTrackedOrders(driverId, fix);
  }

  getLatestDriverLocation(driverId: string): LiveDriverLocation | null {
    return this.driverLocations.get(driverId) ?? null;
  }

  emitOrderStatusChanged(payload: OrderStatusBroadcast): void {
    if (!this.server) return;
    const wire = {
      orderId: payload.orderId,
      orderNumber: payload.orderNumber,
      status: payload.status,
      activeLeg: payload.activeLeg,
      updatedAt: payload.updatedAt,
    };
    this.server.to(`order:${payload.orderId}`).emit('order:status:changed', wire);
    this.emitToUser(payload.customerUserId, 'order:status:changed', wire);
    for (const driverUserId of payload.driverUserIds ?? []) {
      this.emitToUser(driverUserId, 'order:status:changed', wire);
    }

    if (
      payload.status === 'ARRIVED_FOR_PICKUP' ||
      payload.status === 'ARRIVED_FOR_DELIVERY'
    ) {
      const arrivedWire = {
        orderId: payload.orderId,
        activeLeg: payload.activeLeg,
        status: payload.status,
        updatedAt: payload.updatedAt,
      };
      this.server.to(`order:${payload.orderId}`).emit('order:driver_arrived', arrivedWire);
      this.emitToUser(payload.customerUserId, 'order:driver_arrived', arrivedWire);
    }
  }

  emitOrderEtaUpdated(
    customerUserId: string,
    driverUserId: string | null | undefined,
    payload: OrderEtaBroadcast,
  ): void {
    if (!this.server) return;
    this.server.to(`order:${payload.orderId}`).emit('order:eta:updated', payload);
    this.emitToUser(customerUserId, 'order:eta:updated', payload);
    if (driverUserId) {
      this.emitToUser(driverUserId, 'order:eta:updated', payload);
    }
  }

  emitToUser(userId: string, event: string, data: unknown): void {
    if (!this.server) return;
    const sockets = this.userSockets.get(userId);
    if (!sockets || sockets.size === 0) return;
    for (const socketId of sockets) {
      this.server.to(socketId).emit(event, data);
    }
  }

  private async broadcastDriverLocationToTrackedOrders(
    driverId: string,
    fix: LiveDriverLocation,
    hintOrderId?: string,
  ): Promise<void> {
    if (!this.server) return;

    // Solo retransmitir ubicación al cliente en órdenes que estén en un estado
    // con seguimiento activo hacia su domicilio (NUNCA en HEADING_TO_FACILITY ni en planta).
    const activeLegs = await this.prisma.fulfillmentLeg.findMany({
      where: {
        driverId,
        ...(hintOrderId ? { orderId: hintOrderId } : {}),
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
        order: {
          status: { in: [...CUSTOMER_LIVE_TRACKING_STATUSES] },
        },
      },
      select: {
        kind: true,
        order: {
          select: {
            id: true,
            status: true,
            customer: { select: { userId: true } },
          },
        },
      },
    });

    const locationAt = new Date(fix.timestamp).toISOString();
    for (const leg of activeLegs) {
      const expectedLeg = liveTrackingLegFor(leg.order.status);
      if (expectedLeg !== leg.kind) continue;

      const payload = {
        orderId: leg.order.id,
        driverId,
        activeLeg: expectedLeg,
        location: {
          lat: fix.lat,
          lng: fix.lng,
          heading: fix.heading,
          speed: fix.speed,
          locationAt,
        },
      };

      this.server.to(`order:${leg.order.id}`).emit('driver:location:updated', payload);
      this.emitToUser(leg.order.customer.userId, 'driver:location:updated', payload);
    }

    this.server.to('admins').emit('admin:driver:location', {
      driverId,
      lat: fix.lat,
      lng: fix.lng,
      heading: fix.heading,
      speed: fix.speed,
      locationAt,
    });
  }

  private async flushLocationWrites(): Promise<void> {
    if (this.locationWriteQueue.size === 0) return;
    const entries = Array.from(this.locationWriteQueue.entries());
    this.locationWriteQueue.clear();

    await Promise.all(
      entries.map(([driverId, fix]) =>
        this.prisma.driver
          .updateMany({
            where: { id: driverId },
            data: {
              latitude: fix.lat,
              longitude: fix.lng,
              locationAt: new Date(fix.timestamp),
            },
          })
          .catch((err: unknown) => {
            this.logger.warn(
              `Batch location update falló para ${driverId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }),
      ),
    );
  }

  private async canUserSubscribeToOrder(
    client: AuthenticatedSocket,
    orderId: string,
  ): Promise<boolean> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        facilityId: true,
        customer: { select: { userId: true } },
        legs: {
          select: {
            driver: { select: { userId: true } },
          },
        },
      },
    });
    if (!order) return false;
    if (client.userRole === 'ADMIN') return true;
    if (client.userRole === 'SUPERVISOR') {
      return order.facilityId === client.facilityId;
    }
    if (client.userRole === 'CLIENT') {
      return order.customer.userId === client.userId;
    }
    if (client.userRole === 'DRIVER') {
      return order.legs.some((l) => l.driver?.userId === client.userId);
    }
    return false;
  }
}
