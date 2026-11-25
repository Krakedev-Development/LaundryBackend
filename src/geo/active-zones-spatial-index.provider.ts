import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildZoneSpatialIndex,
  isPointInBoundingBox,
  isPointInPolygonRing,
  type ZoneSpatialIndex,
} from './geo-spatial.util';

const ACTIVE_ZONES_CACHE_TTL_MS = 60_000;

/**
 * Índice espacial en memoria de zonas activas (portado de AnubisRide).
 * Filtra primero por Bounding Box O(1) y luego ejecuta Ray-Casting.
 * Toda escritura sobre zonas llama a `invalidate()` para reflejar cambios al instante.
 */
@Injectable()
export class ActiveZonesSpatialIndexProvider {
  private readonly logger = new Logger(ActiveZonesSpatialIndexProvider.name);
  private cache: { data: ZoneSpatialIndex[]; expiresAt: number } | null = null;
  private generation = 0;

  constructor(private readonly prisma: PrismaService) {}

  invalidate(): void {
    this.generation += 1;
    this.cache = null;
  }

  async getIndex(): Promise<ZoneSpatialIndex[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.data;
    }

    const generationAtStart = this.generation;
    const zones = await this.prisma.zone.findMany({
      where: { active: true },
      select: { id: true, name: true, polygon: true },
      orderBy: { name: 'asc' },
    });

    const data: ZoneSpatialIndex[] = [];
    for (const zone of zones) {
      const entry = buildZoneSpatialIndex(zone.id, zone.name, zone.polygon);
      if (entry) {
        data.push(entry);
      } else {
        this.logger.warn(
          `Zona ${zone.id} (${zone.name}) excluida del índice espacial: polígono inválido`,
        );
      }
    }

    if (generationAtStart === this.generation) {
      this.cache = { data, expiresAt: now + ACTIVE_ZONES_CACHE_TTL_MS };
    }

    return data;
  }

  async findZoneIdForPoint(lat: number, lng: number): Promise<string | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const index = await this.getIndex();
    for (const entry of index) {
      if (!isPointInBoundingBox(lat, lng, entry.bbox)) continue;
      if (isPointInPolygonRing(lat, lng, entry.ring)) {
        return entry.zoneId;
      }
    }
    return null;
  }
}
