import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RouteCoordinates {
  latitude: number;
  longitude: number;
}

export interface RouteGeometryGeoJson {
  type: 'LineString';
  coordinates: [number, number][]; // [lng, lat]
}

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  geometry: RouteGeometryGeoJson;
  provider: 'mapbox' | 'osrm' | 'fallback';
  isFallback: boolean;
}

export interface DirectionsOptions {
  originBearing?: number;
}

interface CacheEntry {
  data: RouteResult;
  timestamp: number;
  ttl: number;
}

interface DirectionsApiResponse {
  code?: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: {
      type?: string;
      coordinates?: [number, number][];
    };
  }>;
}

const ORIGIN_BEARING_TOLERANCE_DEG = 45;
const EARTH_RADIUS_M = 6_371_000;
const FALLBACK_SPEED_MPS = (25 * 1000) / 3600; // 25 km/h urbano

function haversineMeters(a: RouteCoordinates, b: RouteCoordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return Math.round(EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

function normalizeBearing(bearing: number | undefined): number | undefined {
  if (typeof bearing !== 'number' || !Number.isFinite(bearing)) return undefined;
  return Math.round(((bearing % 360) + 360) % 360);
}

@Injectable()
export class MapboxDirectionsService implements OnModuleDestroy {
  private readonly logger = new Logger(MapboxDirectionsService.name);
  private readonly accessToken: string;
  private readonly mapboxBaseUrl = 'https://api.mapbox.com';

  private readonly cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;
  private readonly MAX_CACHE_SIZE = 1000;

  private requestCount = 0;
  private requestWindowStart = Date.now();
  private readonly MAX_REQUESTS_PER_MINUTE = 300;
  private readonly DIRECTIONS_TIMEOUT_MS = 5_000;

  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly config: ConfigService) {
    this.accessToken = this.config.get<string>('MAPBOX_ACCESS_TOKEN')?.trim() || '';
    if (!this.accessToken) {
      this.logger.warn(
        'MAPBOX_ACCESS_TOKEN no configurado: las rutas usarán OSRM/Haversine como respaldo.',
      );
    }
    this.cleanupTimer = setInterval(() => this.cleanCache(), 10 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  isMapboxConfigured(): boolean {
    return this.accessToken.length > 0;
  }

  async getRouteWithGeometry(
    origin: RouteCoordinates,
    destination: RouteCoordinates,
    options?: DirectionsOptions,
  ): Promise<RouteResult> {
    const bearing = normalizeBearing(options?.originBearing);
    const cacheKey = this.buildCacheKey(origin, destination, bearing);
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    if (this.accessToken && this.consumeRateBudget()) {
      const mapboxRoute = await this.fetchMapboxRoute(origin, destination, bearing);
      if (mapboxRoute) {
        this.setCached(cacheKey, mapboxRoute);
        return mapboxRoute;
      }
    }

    const osrmRoute = await this.fetchOsrmRoute(origin, destination);
    if (osrmRoute) {
      this.setCached(cacheKey, osrmRoute);
      return osrmRoute;
    }

    return this.buildFallbackRoute(origin, destination);
  }

  private async fetchMapboxRoute(
    origin: RouteCoordinates,
    destination: RouteCoordinates,
    bearing?: number,
  ): Promise<RouteResult | null> {
    const coords = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const params = new URLSearchParams({
      geometries: 'geojson',
      overview: 'full',
      alternatives: 'false',
      access_token: this.accessToken,
    });
    if (bearing !== undefined) {
      params.set('bearings', `${bearing},${ORIGIN_BEARING_TOLERANCE_DEG};`);
    }

    const url = `${this.mapboxBaseUrl}/directions/v5/mapbox/driving-traffic/${coords}?${params.toString()}`;
    return this.fetchDirectionsJson(url, 'mapbox');
  }

  private async fetchOsrmRoute(
    origin: RouteCoordinates,
    destination: RouteCoordinates,
  ): Promise<RouteResult | null> {
    const coords = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    return this.fetchDirectionsJson(url, 'osrm');
  }

  private async fetchDirectionsJson(
    url: string,
    provider: 'mapbox' | 'osrm',
  ): Promise<RouteResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.DIRECTIONS_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        this.logger.warn(`${provider} Directions respondió HTTP ${response.status}`);
        return null;
      }
      const data = (await response.json()) as DirectionsApiResponse;
      const route = data.routes?.[0];
      const rawCoords = route?.geometry?.coordinates;
      if (!route || !Array.isArray(rawCoords) || rawCoords.length < 2) {
        return null;
      }
      const validCoords = rawCoords.filter(
        (pair): pair is [number, number] =>
          Array.isArray(pair) &&
          pair.length >= 2 &&
          Number.isFinite(pair[0]) &&
          Number.isFinite(pair[1]),
      );
      if (validCoords.length < 2) return null;

      const distanceMeters = Number(route.distance);
      const durationSeconds = Number(route.duration);
      if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
        return null;
      }

      return {
        distanceMeters: Math.round(distanceMeters),
        durationSeconds: Math.round(durationSeconds),
        geometry: { type: 'LineString', coordinates: validCoords },
        provider,
        isFallback: false,
      };
    } catch (error) {
      this.logger.warn(
        `${provider} Directions falló: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  buildFallbackRoute(
    origin: RouteCoordinates,
    destination: RouteCoordinates,
  ): RouteResult {
    const distanceMeters = haversineMeters(origin, destination);
    const durationSeconds = Math.max(
      60,
      Math.round(distanceMeters / FALLBACK_SPEED_MPS),
    );
    return {
      distanceMeters,
      durationSeconds,
      geometry: {
        type: 'LineString',
        coordinates: [
          [origin.longitude, origin.latitude],
          [destination.longitude, destination.latitude],
        ],
      },
      provider: 'fallback',
      isFallback: true,
    };
  }

  private buildCacheKey(
    origin: RouteCoordinates,
    destination: RouteCoordinates,
    bearing?: number,
  ): string {
    const r = (v: number) => Math.round(v * 10_000) / 10_000;
    const bearingBucket = bearing !== undefined ? Math.round(bearing / 15) * 15 : 'none';
    return `${r(origin.latitude)},${r(origin.longitude)}->${r(destination.latitude)},${r(destination.longitude)}:${bearingBucket}`;
  }

  private getCached(key: string): RouteResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setCached(key: string, data: RouteResult): void {
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { data, timestamp: Date.now(), ttl: this.CACHE_TTL_MS });
  }

  private cleanCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }

  private consumeRateBudget(): boolean {
    const now = Date.now();
    if (now - this.requestWindowStart >= 60_000) {
      this.requestWindowStart = now;
      this.requestCount = 0;
    }
    if (this.requestCount >= this.MAX_REQUESTS_PER_MINUTE) {
      this.logger.warn('Límite interno de 300 req/min a Mapbox alcanzado');
      return false;
    }
    this.requestCount += 1;
    return true;
  }
}
