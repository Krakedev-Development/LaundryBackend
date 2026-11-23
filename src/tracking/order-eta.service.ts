import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import type { OrderStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MapboxDirectionsService } from './mapbox-directions.service';
import {
  isLiveCustomerTrackingStatus,
  isLocationFresh,
  liveTrackingLegFor,
  validateDriverCoordinates,
} from './tracking.constants';
import { TrackingGateway } from './tracking.gateway';

const ETA_PUSH_INTERVAL_MS = 30_000;

export interface ResolvedDriverPosition {
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  locationAt: string | null;
}

@Injectable()
export class OrderEtaService implements OnModuleDestroy {
  private readonly logger = new Logger(OrderEtaService.name);
  private readonly intervalsByOrderId = new Map<
    string,
    ReturnType<typeof setInterval>
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mapbox: MapboxDirectionsService,
    private readonly gateway: TrackingGateway,
  ) {}

  onModuleDestroy(): void {
    for (const timer of this.intervalsByOrderId.values()) {
      clearInterval(timer);
    }
    this.intervalsByOrderId.clear();
  }

  syncTrackingForStatus(orderId: string, status: OrderStatus): void {
    if (isLiveCustomerTrackingStatus(status)) {
      this.startPeriodicEta(orderId);
      void this.pushEtaForOrder(orderId);
    } else {
      this.stopPeriodicEta(orderId);
    }
  }

  startPeriodicEta(orderId: string): void {
    if (this.intervalsByOrderId.has(orderId)) return;
    const timer = setInterval(() => {
      void this.pushEtaForOrder(orderId);
    }, ETA_PUSH_INTERVAL_MS);
    timer.unref();
    this.intervalsByOrderId.set(orderId, timer);
  }

  stopPeriodicEta(orderId: string): void {
    const existing = this.intervalsByOrderId.get(orderId);
    if (!existing) return;
    clearInterval(existing);
    this.intervalsByOrderId.delete(orderId);
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

  async getRouteForOrder(
    orderId: string,
    query: {
      driverLat?: number;
      driverLng?: number;
      driverHeading?: number;
    },
  ) {
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

    const driverPos = this.resolveBestDriverPosition(
      leg.driver,
      query.driverLat,
      query.driverLng,
      query.driverHeading,
    );
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
    if (!activeLeg) {
      this.stopPeriodicEta(orderId);
      return null;
    }

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
    overrideLat?: number,
    overrideLng?: number,
    overrideHeading?: number,
  ): ResolvedDriverPosition | null {
    if (
      overrideLat !== undefined &&
      overrideLng !== undefined &&
      !validateDriverCoordinates(overrideLat, overrideLng)
    ) {
      return {
        lat: overrideLat,
        lng: overrideLng,
        heading: overrideHeading,
        locationAt: new Date().toISOString(),
      };
    }

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
