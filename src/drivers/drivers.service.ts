import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { haversineMeters } from '../tracking/driver-inactivity.util';
import type {
  ListDriversQuery,
  LocationHistoryQuery,
  UpdateDriverDto,
  UpdateLocationDto,
} from './dto/drivers.dto';

// Un tramo cuenta como carga activa mientras no esté cerrado.
const ACTIVE_LEG: Prisma.FulfillmentLegWhereInput = {
  status: { notIn: ['COMPLETED', 'CANCELLED'] },
};

const DRIVER_INCLUDE = {
  user: { select: { name: true, email: true, phone: true } },
  facility: { select: { name: true } },
  _count: { select: { legs: { where: ACTIVE_LEG } } },
} satisfies Prisma.DriverInclude;

type DriverRow = Prisma.DriverGetPayload<{ include: typeof DRIVER_INCLUDE }>;

// Sin sede asignada el supervisor no ve ningún chofer.
const NO_FACILITY = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly tracking?: TrackingGateway,
  ) {}

  // ---- Gestión (administrador y supervisor)

  async list(user: AuthUser, q: ListDriversQuery) {
    const where: Prisma.DriverWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      facilityId:
        user.role === 'SUPERVISOR' ? (user.facilityId ?? NO_FACILITY) : q.facilityId,
    };
    const rows = await this.prisma.driver.findMany({
      where,
      include: DRIVER_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((d) => this.view(d));
  }

  async get(user: AuthUser, id: string) {
    return this.view(await this.scoped(user, id));
  }

  async locationHistory(user: AuthUser, id: string, q: LocationHistoryQuery) {
    const driver = await this.scoped(user, id);
    const maxWindowMs = 24 * 60 * 60 * 1000;
    const defaultWindowMs = 6 * 60 * 60 * 1000;

    const toDate = q.to ? new Date(q.to) : new Date();
    const rawFrom = q.from
      ? new Date(q.from)
      : new Date(toDate.getTime() - defaultWindowMs);
    const fromDate =
      toDate.getTime() - rawFrom.getTime() > maxWindowMs
        ? new Date(toDate.getTime() - maxWindowMs)
        : rawFrom;

    if (fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException(
        'La fecha inicial no puede ser posterior a la fecha final.',
      );
    }

    const limit = Math.min(Math.max(q.limit ?? 500, 1), 1000);
    const rows = await this.prisma.driverLocationPoint.findMany({
      where: {
        driverId: driver.id,
        ...(q.orderId ? { orderId: q.orderId } : {}),
        recordedAt: { gte: fromDate, lte: toDate },
      },
      orderBy: { recordedAt: 'asc' },
      take: limit,
      select: {
        id: true,
        orderId: true,
        latitude: true,
        longitude: true,
        heading: true,
        speed: true,
        recordedAt: true,
      },
    });

    const points = rows.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      heading: r.heading,
      speed: r.speed,
      recordedAt: r.recordedAt.toISOString(),
    }));

    let distanceMeters = 0;
    for (let i = 1; i < points.length; i++) {
      distanceMeters += haversineMeters(
        points[i - 1].lat,
        points[i - 1].lng,
        points[i].lat,
        points[i].lng,
      );
    }

    return {
      driverId: driver.id,
      driverName: driver.user.name,
      facilityId: driver.facilityId,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      totalPoints: points.length,
      distanceMeters: Math.round(distanceMeters),
      firstAt: points[0]?.recordedAt ?? null,
      lastAt: points[points.length - 1]?.recordedAt ?? null,
      points,
    };
  }

  async update(user: AuthUser, id: string, dto: UpdateDriverDto) {
    await this.scoped(user, id);
    if (dto.facilityId !== undefined) {
      if (user.role === 'SUPERVISOR' && dto.facilityId !== user.facilityId)
        throw new ForbiddenException('Solo puedes asignar choferes a tu sede.');
      const facility = await this.prisma.facility.findUnique({
        where: { id: dto.facilityId },
      });
      if (!facility || !facility.active)
        throw new NotFoundException('La sede no existe o está inactiva.');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const driver = await tx.driver.update({
        where: { id },
        data: {
          facilityId: dto.facilityId,
          vehicle: dto.vehicle?.trim(),
          plate: dto.plate?.trim().toUpperCase(),
          status: dto.status,
        },
        include: DRIVER_INCLUDE,
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'DRIVER_UPDATED',
          entity: 'Driver',
          entityId: id,
          after: JSON.parse(JSON.stringify(dto)) as Prisma.InputJsonValue,
        },
      });
      return this.view(driver);
    });
    // Sede, vehículo, placa o estado cambiaron: el mapa operativo vuelve a leerlos.
    this.tracking?.invalidateDriverProfile(id);
    return updated;
  }

  // ---- Perfil y telemetría del chofer autenticado

  async me(user: AuthUser) {
    return this.view(await this.ownProfile(user));
  }

  async updateLocation(user: AuthUser, dto: UpdateLocationDto) {
    const hasLat = dto.latitude !== undefined;
    const hasLng = dto.longitude !== undefined;
    if (hasLat !== hasLng)
      throw new BadRequestException('Envía latitud y longitud juntas.');
    if (!hasLat && !dto.status)
      throw new BadRequestException('Envía la ubicación, el estado o ambos.');
    const own = await this.ownProfile(user);
    const driver = await this.prisma.driver.update({
      where: { id: own.id },
      data: {
        ...(hasLat
          ? { latitude: dto.latitude, longitude: dto.longitude, locationAt: new Date() }
          : {}),
        status: dto.status,
      },
      include: DRIVER_INCLUDE,
    });
    if (dto.status) this.tracking?.invalidateDriverProfile(driver.id);
    if (hasLat && dto.latitude !== undefined && dto.longitude !== undefined) {
      void this.tracking?.recordDriverLocationFromHttp(
        driver.id,
        dto.latitude,
        dto.longitude,
        dto.heading,
        dto.speed,
      );
    }
    if (dto.status === 'OFFLINE') {
      this.tracking?.emitDriverOfflineToAdminMap(driver.id, driver.facilityId);
    } else if (dto.status && !hasLat) {
      void this.tracking?.emitDriverProfileToAdminMap(driver.id);
    }
    return this.view(driver);
  }

  // ---- Utilidades

  private async ownProfile(user: AuthUser) {
    const driver = await this.prisma.driver.findUnique({
      where: { userId: user.id },
      include: DRIVER_INCLUDE,
    });
    if (!driver) throw new NotFoundException('Tu cuenta no tiene perfil de chofer.');
    return driver;
  }

  // El supervisor opera únicamente sobre los choferes de su sede.
  private async scoped(user: AuthUser, id: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { id },
      include: DRIVER_INCLUDE,
    });
    if (!driver || (user.role === 'SUPERVISOR' && driver.facilityId !== user.facilityId))
      throw new NotFoundException('El chofer no existe.');
    return driver;
  }

  private view(d: DriverRow) {
    return {
      id: d.id,
      userId: d.userId,
      name: d.user.name,
      email: d.user.email,
      phone: d.user.phone,
      status: d.status,
      vehicle: d.vehicle,
      plate: d.plate,
      facilityId: d.facilityId,
      facilityName: d.facility.name,
      latitude: d.latitude === null ? null : Number(d.latitude),
      longitude: d.longitude === null ? null : Number(d.longitude),
      locationAt: d.locationAt ? d.locationAt.toISOString() : null,
      activeLegsCount: d._count.legs,
    };
  }
}
