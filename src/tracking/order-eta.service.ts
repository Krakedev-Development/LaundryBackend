import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { OrderStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MapboxDirectionsService } from './mapbox-directions.service';
import {
  CUSTOMER_LIVE_TRACKING_STATUSES,
  isLiveCustomerTrackingStatus,
  isLocationFresh,
  liveTrackingLegFor,
  validateDriverCoordinates,
} from './tracking.constants';
import { TrackingGateway } from './tracking.gateway';

const ETA_PUSH_INTERVAL_MS = 30_000;
// Consultas de ruta y tiempo estimado por usuario y minuto. La app del cliente usa unas 14 en
// el peor caso (respaldo cada 30 s y recálculo por desvío cada 5 s como mínimo).
export const TRACKING_QUERIES_PER_MINUTE = 30;
const TRACKING_BUDGET_WINDOW_MS = 60_000;

export interface ResolvedDriverPosition {
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  locationAt: string | null;
}

@Injectable()
export class OrderEtaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderEtaService.name);
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private readonly queriesByUser = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mapbox: MapboxDirectionsService,
    private readonly gateway: TrackingGateway,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      void this.sweepLiveOrders();
    }, ETA_PUSH_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  // Límite propio por usuario para /route y /eta (el general del HTTP es por IP).
  consumeUserBudget(userId: string, now = Date.now()): void {
    const recent = (this.queriesByUser.get(userId) ?? []).filter(
      (at) => now - at < TRACKING_BUDGET_WINDOW_MS,
    );
    if (recent.length >= TRACKING_QUERIES_PER_MINUTE) {
      this.queriesByUser.set(userId, recent);
      throw new HttpException(
        'Demasiadas consultas de seguimiento; intenta de nuevo en unos segundos.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.queriesByUser.set(userId, recent);
  }

  // Al cambiar de estado se envía el tiempo estimado de inmediato si el pedido entra (o sigue)
  // en un tramo con seguimiento. El envío periódico lo cubre el barrido.
  syncTrackingForStatus(orderId: string, status: OrderStatus): void {
    if (isLiveCustomerTrackingStatus(status)) void this.pushEtaForOrder(orderId);
  }

  /**
   * Envía el tiempo estimado de todos los pedidos con seguimiento activo. Sale de la base en
   * cada vuelta, así que un reinicio del backend no deja pedidos sin actualizar. Con una sola
   * instancia no hace falta coordinar; con varias se agregaría un bloqueo (ver fase 5 del plan).
   */
  async sweepLiveOrders(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const orders = await this.prisma.order.findMany({
        where: {
          status: { in: [...CUSTOMER_LIVE_TRACKING_STATUSES] },
          legs: { some: { driverId: { not: null } } },
        },
        select: { id: true },
      });
      for (const { id } of orders) await this.pushEtaForOrder(id);
      return orders.length;
    } catch (error) {
      this.logger.warn(
        `Barrido de tiempo estimado falló: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  async pushEtaForOrder(orderId: string): Promise<void> {
    try {
      const result = await this.computeEtaInternal(orderId);
      if (!result) return;
      this.gateway.emitOrderEtaUpdated(
        result.customerUserId,
        result.driverUserId,
        {
          orderId,
          activeLeg: result.activeLeg,
          etaMinutes: result.etaMinutes,
          distanceMeters: result.distanceMeters,
          durationSeconds: result.durationSeconds,
          driverLocation: result.driverLocation
            ? {
                lat: result.driverLocation.lat,
                lng: result.driverLocation.lng,
                heading: result.driverLocation.heading,
                speed: result.driverLocation.speed,
                locationAt:
                  result.driverLocation.locationAt ?? new Date().toISOString(),
              }
            : undefined,
          updatedAt: new Date().toISOString(),
        },
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo emitir ETA para orden ${orderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getRouteForOrder(orderId: string) {
    const order = await this.loadOrderForTracking(orderId);
    const activeLeg = liveTrackingLegFor(order.status);
    if (!activeLeg) {
      throw new BadRequestException(
        'El seguimiento en vivo no está activo en el estado actual del pedido.',
      );
    }

    const leg = order.legs.find((l) => l.kind === activeLeg);
    if (!leg) {
      throw new NotFoundException('No existe el tramo activo para este pedido.');
    }

    const driverPos = this.resolveBestDriverPosition(leg.driver);
    if (!driverPos) {
      throw new NotFoundException(
        'La ubicación del chofer aún no está disponible.',
      );
    }

    const destination = {
      latitude: Number(leg.latitude),
      longitude: Number(leg.longitude),
    };
    const route = await this.mapbox.getRouteWithGeometry(
      { latitude: driverPos.lat, longitude: driverPos.lng },
      destination,
      { originBearing: driverPos.heading },
    );

    return {
      success: true,
      data: {
        orderId: order.id,
        activeLeg,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        etaMinutes: Math.max(1, Math.round(route.durationSeconds / 60)),
        provider: route.provider,
        isFallback: route.isFallback,
        geometry: route.geometry,
      },
    };
  }

  async getEtaForOrder(orderId: string) {
    const order = await this.loadOrderForTracking(orderId);
    const activeLeg = liveTrackingLegFor(order.status);
    if (!activeLeg) {
      return {
        success: true,
        data: {
          orderId: order.id,
          status: order.status,
          activeLeg: null,
          isLiveTrackingActive: false,
          etaMinutes: null,
          distanceMeters: null,
          durationSeconds: null,
          driverLocation: null,
        },
      };
    }

    const computed = await this.computeEtaInternal(orderId);
    return {
      success: true,
      data: {
        orderId: order.id,
        status: order.status,
        activeLeg,
        isLiveTrackingActive: true,
        etaMinutes: computed?.etaMinutes ?? null,
        distanceMeters: computed?.distanceMeters ?? null,
        durationSeconds: computed?.durationSeconds ?? null,
        driverLocation: computed?.driverLocation ?? null,
      },
    };
  }

  private async computeEtaInternal(orderId: string) {
    const order = await this.loadOrderForTracking(orderId);
    const activeLeg = liveTrackingLegFor(order.status);
    if (!activeLeg) return null;

    const leg = order.legs.find((l) => l.kind === activeLeg);
    if (!leg || !leg.driver) return null;

    const driverPos = this.resolveBestDriverPosition(leg.driver);
    if (!driverPos) return null;

    const destination = {
      latitude: Number(leg.latitude),
      longitude: Number(leg.longitude),
    };
    const route = await this.mapbox.getRouteWithGeometry(
      { latitude: driverPos.lat, longitude: driverPos.lng },
      destination,
      { originBearing: driverPos.heading },
    );

    return {
      activeLeg,
      customerUserId: order.customer.userId,
      driverUserId: leg.driver.userId,
      etaMinutes:
        order.status === 'ARRIVED_FOR_PICKUP' ||
        order.status === 'ARRIVED_FOR_DELIVERY'
          ? 0
          : Math.max(1, Math.round(route.durationSeconds / 60)),
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      driverLocation: driverPos,
    };
  }

  private resolveBestDriverPosition(
    driver: {
      id: string;
      latitude: unknown;
      longitude: unknown;
      locationAt: Date | null;
    } | null,
  ): ResolvedDriverPosition | null {
    if (!driver) return null;

    const mem = this.gateway.getLatestDriverLocation(driver.id);
    if (mem && isLocationFresh(mem.timestamp)) {
      return {
        lat: mem.lat,
        lng: mem.lng,
        heading: mem.heading,
        speed: mem.speed,
        locationAt: new Date(mem.timestamp).toISOString(),
      };
    }

    if (driver.latitude !== null && driver.longitude !== null) {
      const lat = Number(driver.latitude);
      const lng = Number(driver.longitude);
      if (!validateDriverCoordinates(lat, lng)) {
        return {
          lat,
          lng,
          locationAt: driver.locationAt ? driver.locationAt.toISOString() : null,
        };
      }
    }

    return null;
  }

  private async loadOrderForTracking(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        customer: { select: { userId: true } },
        legs: {
          select: {
            kind: true,
            latitude: true,
            longitude: true,
            driver: {
              select: {
                id: true,
                userId: true,
                latitude: true,
                longitude: true,
                locationAt: true,
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('El pedido no existe.');
    return order;
  }
}
