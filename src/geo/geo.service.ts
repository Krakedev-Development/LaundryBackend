import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
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

export interface LatLng {
  lat: number;
  lng: number;
}

// Punto en polígono por trazado de rayo. Los vértices son [{lat,lng}].
export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses =
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng;
    if (crosses) inside = !inside;
  }
  return inside;
}

// Campos de una sede visibles para clientes y choferes (sin datos administrativos).
export function publicFacility<T extends Record<string, unknown>>(f: T) {
  const {
    id, zoneId, name, address, city, phone, openingHours, latitude, longitude, active,
  } = f as Record<string, unknown>;
  return { id, zoneId, name, address, city, phone, openingHours, latitude, longitude, active };
}

@Injectable()
export class GeoService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Zonas

  listZones(includeInactive: boolean) {
    return this.prisma.zone.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: { name: 'asc' },
    });
  }

  async createZone(actor: AuthUser, dto: CreateZoneDto) {
    const data = {
      name: dto.name.trim(),
      polygon: this.polygon(dto.polygon),
    };
    return this.prisma.$transaction(async (tx) => {
      const zone = await tx.zone
        .create({ data })
        .catch((e) => this.mapUnique(e, 'Ya existe una zona con ese nombre.'));
      await this.audit(tx, actor, 'ZONE_CREATED', 'Zone', zone.id);
      return zone;
    });
  }

  async updateZone(actor: AuthUser, id: string, dto: UpdateZoneDto) {
    await this.zoneOrFail(id);
    if (dto.active === false) await this.assertZoneHasNoActiveFacilities(id);
    return this.prisma.$transaction(async (tx) => {
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
  }

  // Zona que cubre una coordenada, o null si está fuera de cobertura.
  async resolveZone(point: LatLng) {
    const zones = await this.prisma.zone.findMany({ where: { active: true } });
    return (
      zones.find((z) =>
        pointInPolygon(point, z.polygon as unknown as LatLng[]),
      ) ?? null
    );
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
    return this.prisma.$transaction(async (tx) => {
      const facility = await tx.facility.create({
        data: this.facilityData(dto) as Prisma.FacilityUncheckedCreateInput,
      });
      await this.audit(tx, actor, 'FACILITY_CREATED', 'Facility', facility.id);
      return facility;
    });
  }

  async updateFacility(actor: AuthUser, id: string, dto: UpdateFacilityDto) {
    await this.getFacility(id);
    if (dto.zoneId) {
      const zone = await this.zoneOrFail(dto.zoneId);
      if (!zone.active) throw new BadRequestException('La zona está inactiva.');
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
