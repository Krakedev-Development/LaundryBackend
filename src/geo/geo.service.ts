import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateFacilityDto,
  CreateZoneDto,
  PolygonPointDto,
  UpdateFacilityDto,
  UpdateZoneDto,
} from './dto/geo.dto';
import { ActiveZonesSpatialIndexProvider } from './active-zones-spatial-index.provider';
import {
  isPointInPolygon,
  validatePolygonGeometry,
  type LatLng,
} from './geo-spatial.util';
import { evaluateDriverInactivityAlerts } from '../tracking/driver-inactivity.util';

export type { LatLng };

// Punto en polígono por Bounding Box + trazado de rayo. Los vértices son [{lat,lng}].
export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  return isPointInPolygon(point.lat, point.lng, polygon);
}

// Sin sede asignada el supervisor no ve sedes ni choferes.
const NO_FACILITY = '00000000-0000-0000-0000-000000000000';

const PICKUP_MAP_STATUSES = [
  'CONFIRMED',
  'PICKUP_ASSIGNED',
  'HEADING_TO_PICKUP',
  'ARRIVED_FOR_PICKUP',
] as const;

const DELIVERY_MAP_STATUSES = [
  'DELIVERY_ASSIGNED',
  'OUT_FOR_DELIVERY',
  'ARRIVED_FOR_DELIVERY',
] as const;

// Campos de una sede visibles para clientes y choferes (sin datos administrativos).
export function publicFacility<T extends Record<string, unknown>>(f: T) {
  const {
    id, zoneId, name, address, city, phone, openingHours, latitude, longitude, active,
  } = f as Record<string, unknown>;
  return { id, zoneId, name, address, city, phone, openingHours, latitude, longitude, active };
}

@Injectable()
export class GeoService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly spatialIndex?: ActiveZonesSpatialIndexProvider,
  ) {}

  // ---- Zonas

  listZones(includeInactive: boolean) {
    return this.prisma.zone.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: { name: 'asc' },
    });
  }

  async createZone(actor: AuthUser, dto: CreateZoneDto) {
    const geomError = validatePolygonGeometry(dto.polygon);
    if (geomError) throw new BadRequestException(geomError);

    const data = {
      name: dto.name.trim(),
      polygon: this.polygon(dto.polygon),
    };
    const created = await this.prisma.$transaction(async (tx) => {
      const zone = await tx.zone
        .create({ data })
        .catch((e) => this.mapUnique(e, 'Ya existe una zona con ese nombre.'));
      await this.audit(tx, actor, 'ZONE_CREATED', 'Zone', zone.id);
      return zone;
    });
    this.spatialIndex?.invalidate();
    return created;
  }

  async updateZone(actor: AuthUser, id: string, dto: UpdateZoneDto) {
    await this.zoneOrFail(id);
    if (dto.polygon) {
      const geomError = validatePolygonGeometry(dto.polygon);
      if (geomError) throw new BadRequestException(geomError);
      await this.assertLinkedFacilitiesInsidePolygon(id, dto.polygon);
    }
    if (dto.active === false) await this.assertZoneHasNoActiveFacilities(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const zone = await tx.zone
        .update({
          where: { id },
          data: {
            name: dto.name?.trim(),
            polygon: dto.polygon ? this.polygon(dto.polygon) : undefined,
            active: dto.active,
          },
        })
        .catch((e) => this.mapUnique(e, 'Ya existe una zona con ese nombre.'));
      await this.audit(tx, actor, 'ZONE_UPDATED', 'Zone', id);
      return zone;
    });
    this.spatialIndex?.invalidate();
    return updated;
  }

  // Zona que cubre una coordenada, o null si está fuera de cobertura.
  async resolveZone(point: LatLng) {
    if (this.spatialIndex) {
      const zoneId = await this.spatialIndex.findZoneIdForPoint(point.lat, point.lng);
      if (!zoneId) return null;
      return this.prisma.zone.findUnique({
        where: { id: zoneId },
        include: {
          facilities: {
            where: { active: true },
            orderBy: { name: 'asc' },
          },
        },
      });
    }

    const zones = await this.prisma.zone.findMany({ where: { active: true } });
    return (
      zones.find((z) =>
        pointInPolygon(point, z.polygon as unknown as LatLng[]),
      ) ?? null
    );
  }

  async findZoneByPoint(lat: number, lng: number) {
    const zone = await this.resolveZone({ lat, lng });
    if (!zone) {
      throw new NotFoundException(
        'No se encontró ninguna zona activa para las coordenadas indicadas.',
      );
    }
    return zone;
  }

  // ---- Métricas y Snapshot del Mapa Operativo (ADMIN global / SUPERVISOR acotado a su sede)

  async getZonesMetricsSummary(actor: AuthUser) {
    const scopedFacilityId =
      actor.role === 'SUPERVISOR' ? (actor.facilityId ?? NO_FACILITY) : undefined;

    const facilities = await this.prisma.facility.findMany({
      where: scopedFacilityId ? { id: scopedFacilityId } : {},
      select: { id: true, zoneId: true, active: true },
    });
    const scopedZoneIds = scopedFacilityId
      ? [...new Set(facilities.map((f) => f.zoneId))]
      : undefined;

    const zones = await this.prisma.zone.findMany({
      where: scopedZoneIds ? { id: { in: scopedZoneIds } } : {},
      orderBy: { name: 'asc' },
      select: { id: true, name: true, active: true },
    });

    const facilityIds = facilities.map((f) => f.id);
    const [drivers, orders] = await Promise.all([
      this.prisma.driver.findMany({
        where: facilityIds.length ? { facilityId: { in: facilityIds } } : { facilityId: NO_FACILITY },
        select: { id: true, facilityId: true, status: true },
      }),
      this.prisma.order.findMany({
        where: {
          ...(facilityIds.length ? { facilityId: { in: facilityIds } } : { facilityId: NO_FACILITY }),
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
        select: { id: true, facilityId: true, status: true },
      }),
    ]);

    const facilityToZone = new Map(facilities.map((f) => [f.id, f.zoneId]));

    return zones.map((z) => {
      const zoneFacilities = facilities.filter((f) => f.zoneId === z.id);
      const activeFacilities = zoneFacilities.filter((f) => f.active).length;
      const zoneDrivers = drivers.filter((d) => facilityToZone.get(d.facilityId) === z.id);
      const onlineDrivers = zoneDrivers.filter((d) => d.status !== 'OFFLINE').length;
      const availableDrivers = zoneDrivers.filter((d) => d.status === 'AVAILABLE').length;
      const onServiceDrivers = zoneDrivers.filter((d) => d.status === 'ON_SERVICE').length;
      const zoneOrders = orders.filter((o) => facilityToZone.get(o.facilityId) === z.id);
      const activePickups = zoneOrders.filter((o) =>
        (PICKUP_MAP_STATUSES as readonly string[]).includes(o.status),
      ).length;
      const activeDeliveries = zoneOrders.filter((o) =>
        (DELIVERY_MAP_STATUSES as readonly string[]).includes(o.status),
      ).length;

      return {
        zoneId: z.id,
        zoneName: z.name,
        active: z.active,
        totalFacilities: zoneFacilities.length,
        activeFacilities,
        onlineDrivers,
        availableDrivers,
        onServiceDrivers,
        activeOrders: zoneOrders.length,
        activePickups,
        activeDeliveries,
      };
    });
  }

  async getOperationalSnapshot(actor: AuthUser) {
    const isSupervisor = actor.role === 'SUPERVISOR';
    const scopedFacilityId = isSupervisor ? (actor.facilityId ?? NO_FACILITY) : undefined;

    const facilities = await this.prisma.facility.findMany({
      where: scopedFacilityId ? { id: scopedFacilityId } : {},
      orderBy: { name: 'asc' },
    });

    const facilityIds = facilities.map((f) => f.id);
    const zoneIds = [...new Set(facilities.map((f) => f.zoneId))];

    const [zones, drivers, orders, incidents] = await Promise.all([
      this.prisma.zone.findMany({
        where: isSupervisor ? { id: { in: zoneIds } } : {},
        orderBy: { name: 'asc' },
      }),
      this.prisma.driver.findMany({
        where: isSupervisor
          ? { facilityId: scopedFacilityId }
          : {},
        include: {
          user: { select: { name: true, phone: true } },
          facility: { select: { id: true, name: true, zoneId: true } },
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
          ...(isSupervisor && facilityIds.length
            ? { order: { facilityId: { in: facilityIds } } }
            : isSupervisor
              ? { order: { facilityId: NO_FACILITY } }
              : {}),
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
                select: { latitude: true, longitude: true, addressText: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const driverRows = drivers.map((d) => ({
      driverId: d.id,
      name: d.user.name,
      phone: d.user.phone,
      vehicle: d.vehicle,
      plate: d.plate,
      status: d.status,
      facilityId: d.facilityId,
      zoneId: d.facility.zoneId,
      lat: d.latitude !== null ? Number(d.latitude) : null,
      lng: d.longitude !== null ? Number(d.longitude) : null,
      locationAt: d.locationAt ? d.locationAt.toISOString() : null,
    }));

    const alerts = evaluateDriverInactivityAlerts(
      drivers.map((d) => ({
        driverId: d.id,
        name: d.user.name,
        facilityId: d.facilityId,
        zoneId: d.facility.zoneId,
        status: d.status,
        lat: d.latitude !== null ? Number(d.latitude) : null,
        lng: d.longitude !== null ? Number(d.longitude) : null,
        locationAtMs: d.locationAt ? d.locationAt.getTime() : null,
      })),
    );

    return {
      scope: isSupervisor ? 'SUPERVISOR' : 'ADMIN',
      scopedFacilityId: isSupervisor ? (actor.facilityId ?? null) : null,
      zones,
      facilities: facilities.map((f) => ({
        ...f,
        latitude: Number(f.latitude),
        longitude: Number(f.longitude),
      })),
      drivers: driverRows,
      alerts,
      orders: orders
        .map((o) => {
          const isDelivery = (DELIVERY_MAP_STATUSES as readonly string[]).includes(o.status);
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
        .filter((item): item is NonNullable<typeof item> => item !== null),
      incidents: incidents
        .map((inc) => {
          const leg = inc.order.legs[0];
          if (!leg) return null;
          return {
            incidentId: inc.id,
            orderId: inc.order.id,
            orderNumber: inc.order.number,
            facilityId: inc.order.facilityId,
            zoneId: inc.order.facility.zoneId,
            description: inc.description,
            severity: inc.severity,
            status: inc.status,
            lat: Number(leg.latitude),
            lng: Number(leg.longitude),
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
    };
  }

  // ---- Sedes

  listFacilities(includeInactive: boolean, zoneId?: string) {
    return this.prisma.facility.findMany({
      where: { ...(includeInactive ? {} : { active: true }), zoneId },
      orderBy: { name: 'asc' },
    });
  }

  async getFacility(id: string) {
    const facility = await this.prisma.facility.findUnique({ where: { id } });
    if (!facility) throw new NotFoundException('La sede no existe.');
    return facility;
  }

  async createFacility(actor: AuthUser, dto: CreateFacilityDto) {
    const zone = await this.zoneOrFail(dto.zoneId);
    if (!zone.active) throw new BadRequestException('La zona está inactiva.');
    if (!isPointInPolygon(dto.latitude, dto.longitude, zone.polygon)) {
      throw new UnprocessableEntityException(
        'La ubicación de la sede debe estar dentro del polígono de la zona seleccionada.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const facility = await tx.facility.create({
        data: this.facilityData(dto) as Prisma.FacilityUncheckedCreateInput,
      });
      await this.audit(tx, actor, 'FACILITY_CREATED', 'Facility', facility.id);
      return facility;
    });
  }

  async updateFacility(actor: AuthUser, id: string, dto: UpdateFacilityDto) {
    const existing = await this.getFacility(id);
    const targetZoneId = dto.zoneId ?? existing.zoneId;
    const zone = await this.zoneOrFail(targetZoneId);
    if (dto.zoneId && !zone.active) {
      throw new BadRequestException('La zona está inactiva.');
    }

    const nextLat = dto.latitude ?? Number(existing.latitude);
    const nextLng = dto.longitude ?? Number(existing.longitude);
    if (
      dto.zoneId !== undefined ||
      dto.latitude !== undefined ||
      dto.longitude !== undefined
    ) {
      if (!isPointInPolygon(nextLat, nextLng, zone.polygon)) {
        throw new UnprocessableEntityException(
          'La ubicación de la sede debe permanecer dentro del polígono de su zona.',
        );
      }
    }

    if (dto.active === false) await this.assertFacilityHasNoOpenOrders(id);
    return this.prisma.$transaction(async (tx) => {
      const facility = await tx.facility.update({
        where: { id },
        data: { ...this.facilityData(dto), active: dto.active },
      });
      await this.audit(tx, actor, 'FACILITY_UPDATED', 'Facility', id);
      return facility;
    });
  }

  // ---- Utilidades

  private facilityData(dto: UpdateFacilityDto) {
    const { openingHours, name, address, ...rest } = dto;
    return {
      ...rest,
      name: name?.trim(),
      address: address?.trim(),
      openingHours: openingHours as Prisma.InputJsonValue | undefined,
      // `active` se asigna solo en la actualización.
      active: undefined,
    };
  }

  private polygon(points: PolygonPointDto[]): Prisma.InputJsonValue {
    return points.map((p) => ({ lat: p.lat, lng: p.lng }));
  }

  private async zoneOrFail(id: string) {
    const zone = await this.prisma.zone.findUnique({ where: { id } });
    if (!zone) throw new NotFoundException('La zona no existe.');
    return zone;
  }

  private async assertLinkedFacilitiesInsidePolygon(
    zoneId: string,
    newPolygon: PolygonPointDto[],
  ) {
    const facilities = await this.prisma.facility.findMany({
      where: { zoneId },
      select: { id: true, name: true, latitude: true, longitude: true },
    });
    const outside = facilities.find(
      (f) => !isPointInPolygon(Number(f.latitude), Number(f.longitude), newPolygon),
    );
    if (outside) {
      throw new ConflictException(
        `El nuevo límite dejaría fuera de la zona a la sede "${outside.name}".`,
      );
    }
  }

  private async assertZoneHasNoActiveFacilities(zoneId: string) {
    const count = await this.prisma.facility.count({
      where: { zoneId, active: true },
    });
    if (count > 0)
      throw new ConflictException(
        'La zona tiene sedes activas; desactívalas o reasígnalas primero.',
      );
  }

  private async assertFacilityHasNoOpenOrders(facilityId: string) {
    const count = await this.prisma.order.count({
      where: {
        facilityId,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
    });
    if (count > 0)
      throw new ConflictException(
        'La sede tiene pedidos en curso; no puede desactivarse.',
      );
  }

  private mapUnique(e: unknown, message: string): never {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    )
      throw new ConflictException(message);
    throw e;
  }

  private audit(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    action: string,
    entity: string,
    entityId: string,
  ) {
    return tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entity,
        entityId,
      },
    });
  }
}
