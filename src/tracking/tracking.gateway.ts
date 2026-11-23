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
  facilityId?: string;
  status: OrderStatus;
  activeLeg: 'INBOUND' | 'OUTBOUND' | null;
  customerUserId: string;
  driverUserIds?: string[];
  updatedAt: string;
}

export interface AdminMapDriverPayload {
  driverId: string;
  name: string;
  phone: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string;
  facilityId: string;
  zoneId: string;
  lat: number | null;
  lng: number | null;
  heading?: number;
  speed?: number;
  locationAt: string | null;
}

export interface AdminMapOrderPayload {
  orderId: string;
  orderNumber: number;
  status: OrderStatus;
  kind: 'pickup' | 'delivery';
  facilityId: string;
  zoneId: string;
  customerName: string;
  addressText: string;
  lat: number;
  lng: number;
}

export interface AdminMapIncidentPayload {
  incidentId: string;
  orderId: string;
  orderNumber: number;
  facilityId: string;
  zoneId: string;
  description: string;
  severity: string;
  status: string;
  lat: number;
  lng: number;
}

export interface AdminMapSnapshot {
  scope: 'ADMIN' | 'SUPERVISOR';
  scopedFacilityId: string | null;
  drivers: AdminMapDriverPayload[];
  orders: AdminMapOrderPayload[];
  incidents: AdminMapIncidentPayload[];
  generatedAt: string;
}

const ADMIN_MAP_ALL_ROOM = 'admin:map:all';
const ADMIN_MAP_LOCATION_THROTTLE_MS = 2_000;
const NO_FACILITY_ID = '00000000-0000-0000-0000-000000000000';
const PICKUP_MAP_STATUSES: readonly OrderStatus[] = [
  'CONFIRMED',
  'PICKUP_ASSIGNED',
  'HEADING_TO_PICKUP',
  'ARRIVED_FOR_PICKUP',
];
const DELIVERY_MAP_STATUSES: readonly OrderStatus[] = [
  'DELIVERY_ASSIGNED',
  'OUT_FOR_DELIVERY',
  'ARRIVED_FOR_DELIVERY',
];

function adminFacilityRoom(facilityId: string): string {
  return `admin:map:facility:${facilityId}`;
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
  private readonly adminMapLastEmitAt = new Map<string, number>();
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

  /**
   * Canal operativo del mapa web (`admin:map:*`, portado de AnubisRide).
   * - ADMIN: se une a `admin:map:all` y recibe la operación global.
   * - SUPERVISOR: se une SOLO a `admin:map:facility:<facilityId>` y recibe únicamente
   *   su sede/zona asignada.
   */
  @SubscribeMessage('admin:map:subscribe')
  async handleAdminMapSubscribe(@ConnectedSocket() client: AuthenticatedSocket) {
    if (client.userRole !== 'ADMIN' && client.userRole !== 'SUPERVISOR') {
      return {
        event: 'admin:map:error',
        data: { success: false, error: 'forbidden' },
      };
    }

    if (client.userRole === 'ADMIN') {
      await client.join(ADMIN_MAP_ALL_ROOM);
    } else if (client.facilityId) {
      await client.join(adminFacilityRoom(client.facilityId));
    }

    const snapshot = await this.buildAdminMapSnapshot(
      client.userRole,
      client.facilityId ?? null,
    );
    client.emit('admin:map:snapshot', snapshot);

    return {
      event: 'admin:map:subscribed',
      data: {
        success: true,
        scope: snapshot.scope,
        scopedFacilityId: snapshot.scopedFacilityId,
        drivers: snapshot.drivers.length,
        orders: snapshot.orders.length,
        incidents: snapshot.incidents.length,
      },
    };
  }

  @SubscribeMessage('admin:map:unsubscribe')
  async handleAdminMapUnsubscribe(@ConnectedSocket() client: AuthenticatedSocket) {
    await client.leave(ADMIN_MAP_ALL_ROOM);
    if (client.facilityId) {
      await client.leave(adminFacilityRoom(client.facilityId));
    }
    return { event: 'admin:map:unsubscribed', data: { success: true } };
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

    // Notificar al mapa operativo (ADMIN global + SUPERVISOR de la sede).
    this.emitToAdminMap(payload.facilityId, 'admin:map:order-updated', {
      orderId: payload.orderId,
      orderNumber: payload.orderNumber,
      status: payload.status,
      activeLeg: payload.activeLeg,
      facilityId: payload.facilityId ?? null,
      updatedAt: payload.updatedAt,
    });
  }

  emitDriverOfflineToAdminMap(driverId: string, facilityId?: string): void {
    this.emitToAdminMap(facilityId, 'admin:map:driver-offline', { driverId });
  }

  async emitDriverProfileToAdminMap(driverId: string): Promise<void> {
    if (!this.server) return;
    const d = await this.prisma.driver.findUnique({
      where: { id: driverId },
      include: {
        user: { select: { name: true, phone: true } },
        facility: { select: { id: true, zoneId: true } },
      },
    });
    if (!d) return;
    const live = this.driverLocations.get(driverId);
    const payload: AdminMapDriverPayload = {
      driverId: d.id,
      name: d.user.name,
      phone: d.user.phone,
      vehicle: d.vehicle,
      plate: d.plate,
      status: d.status,
      facilityId: d.facilityId,
      zoneId: d.facility.zoneId,
      lat: live?.lat ?? (d.latitude !== null ? Number(d.latitude) : null),
      lng: live?.lng ?? (d.longitude !== null ? Number(d.longitude) : null),
      heading: live?.heading,
      speed: live?.speed,
      locationAt: live
        ? new Date(live.timestamp).toISOString()
        : d.locationAt
          ? d.locationAt.toISOString()
          : null,
    };
    this.emitToAdminMap(d.facilityId, 'admin:map:driver-locations', {
      drivers: [payload],
    });
  }

  private emitToAdminMap(
    facilityId: string | null | undefined,
    event: string,
    data: unknown,
  ): void {
    if (!this.server) return;
    this.server.to(ADMIN_MAP_ALL_ROOM).emit(event, data);
    if (facilityId) {
      this.server.to(adminFacilityRoom(facilityId)).emit(event, data);
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

    // Emisión throttled al canal `admin:map:*` respetando alcance ADMIN vs SUPERVISOR por sede.
    const now = Date.now();
    const lastEmit = this.adminMapLastEmitAt.get(driverId) ?? 0;
    if (now - lastEmit >= ADMIN_MAP_LOCATION_THROTTLE_MS) {
      this.adminMapLastEmitAt.set(driverId, now);
      await this.emitDriverProfileToAdminMap(driverId);
    }
  }

  private async buildAdminMapSnapshot(
    role: 'ADMIN' | 'SUPERVISOR',
    facilityId: string | null,
  ): Promise<AdminMapSnapshot> {
    const isSupervisor = role === 'SUPERVISOR';
    const scopedFacilityId = isSupervisor ? (facilityId ?? NO_FACILITY_ID) : undefined;

    const [drivers, orders, incidents] = await Promise.all([
      this.prisma.driver.findMany({
        where: isSupervisor ? { facilityId: scopedFacilityId } : {},
        include: {
          user: { select: { name: true, phone: true } },
          facility: { select: { id: true, zoneId: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.order.findMany({
        where: {
          ...(isSupervisor ? { facilityId: scopedFacilityId } : {}),
          status: { in: [...PICKUP_MAP_STATUSES, ...DELIVERY_MAP_STATUSES] },
        },
        include: {
          customer: { include: { user: { select: { name: true } } } },
          facility: { select: { id: true, zoneId: true } },
          legs: {
            select: {
              kind: true,
              addressText: true,
              latitude: true,
              longitude: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.incident.findMany({
        where: {
          status: { in: ['OPEN', 'IN_REVIEW'] },
          ...(isSupervisor ? { order: { facilityId: scopedFacilityId } } : {}),
        },
        include: {
          order: {
            select: {
              id: true,
              number: true,
              facilityId: true,
              facility: { select: { zoneId: true } },
              legs: {
                where: { kind: 'INBOUND' },
                select: { latitude: true, longitude: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      scope: role,
      scopedFacilityId: isSupervisor ? facilityId : null,
      drivers: drivers.map((d) => {
        const live = this.driverLocations.get(d.id);
        return {
          driverId: d.id,
          name: d.user.name,
          phone: d.user.phone,
          vehicle: d.vehicle,
          plate: d.plate,
          status: d.status,
          facilityId: d.facilityId,
          zoneId: d.facility.zoneId,
          lat: live?.lat ?? (d.latitude !== null ? Number(d.latitude) : null),
          lng: live?.lng ?? (d.longitude !== null ? Number(d.longitude) : null),
          heading: live?.heading,
          speed: live?.speed,
          locationAt: live
            ? new Date(live.timestamp).toISOString()
            : d.locationAt
              ? d.locationAt.toISOString()
              : null,
        };
      }),
      orders: orders
        .map((o) => {
          const isDelivery = DELIVERY_MAP_STATUSES.includes(o.status);
          const leg =
            o.legs.find((l) => l.kind === (isDelivery ? 'OUTBOUND' : 'INBOUND')) ??
            o.legs[0];
          if (!leg) return null;
          return {
            orderId: o.id,
            orderNumber: o.number,
            status: o.status,
            kind: isDelivery ? ('delivery' as const) : ('pickup' as const),
            facilityId: o.facilityId,
            zoneId: o.facility.zoneId,
            customerName: o.customer.user.name,
            addressText: leg.addressText,
            lat: Number(leg.latitude),
            lng: Number(leg.longitude),
          };
        })
        .filter((x): x is AdminMapOrderPayload => x !== null),
      incidents: incidents
        .map((inc): AdminMapIncidentPayload | null => {
          const leg = inc.order.legs[0];
          if (!leg) return null;
          return {
            incidentId: inc.id,
            orderId: inc.order.id,
            orderNumber: inc.order.number,
            facilityId: inc.order.facilityId,
            zoneId: inc.order.facility.zoneId,
            description: inc.description,
            severity: String(inc.severity),
            status: String(inc.status),
            lat: Number(leg.latitude),
            lng: Number(leg.longitude),
          };
        })
        .filter((x): x is AdminMapIncidentPayload => x !== null),
      generatedAt: new Date().toISOString(),
    };
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
