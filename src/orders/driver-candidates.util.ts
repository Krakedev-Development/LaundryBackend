import { haversineMeters } from '../tracking/driver-inactivity.util';
import { isLocationFresh } from '../tracking/tracking.constants';

export type RouteFitKind =
  | 'ON_ROUTE'
  | 'NEAR_ROUTE'
  | 'DIRECT'
  | 'DETOUR'
  | 'GPS_PENDING';

export interface RouteStopCoord {
  lat: number;
  lng: number;
}

export interface CandidateDriverInput {
  driverId: string;
  name: string;
  phone: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string;
  facilityId: string;
  authorizedZoneIds: string[];
  lat: number | null;
  lng: number | null;
  locationAtMs: number | null;
  activeStops: RouteStopCoord[];
  activeLegsCount: number;
}

export interface CandidateTargetInput {
  facilityId: string;
  zoneId: string;
  target: RouteStopCoord;
  facilityCoord: RouteStopCoord;
  enforceDriverLimit: boolean;
  driverLimit: number | null;
}

export interface RankedDriverCandidate {
  driverId: string;
  name: string;
  phone: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string;
  eligible: true;
  gpsFresh: boolean;
  etaSeconds: number | null;
  distanceMeters: number | null;
  detourMeters: number | null;
  routeFit: RouteFitKind;
  activeStopsCount: number;
  maxOrders: number;
  score: number;
  reasons: string[];
}

export interface ExcludedDriverCandidate {
  driverId: string;
  name: string;
  status: string;
  reasons: string[];
  locationAt: string | null;
}

const DEFAULT_MAX_ORDERS = 8;
const URBAN_FALLBACK_SPEED_MPS = 25 / 3.6; // ~25 km/h
const ROAD_SINUOSITY_FACTOR = 1.3;
const ON_ROUTE_DETOUR_METERS = 1_500;
const NEAR_ROUTE_DETOUR_METERS = 4_000;

/**
 * Calcula el desvío mínimo (en metros, aproximado a vía real con factor 1.3)
 * para insertar `target` en la secuencia de paradas `[start, ...activeStops, anchor]`.
 */
export function computeRouteInsertionDetour(
  start: RouteStopCoord,
  activeStops: RouteStopCoord[],
  target: RouteStopCoord,
  anchor?: RouteStopCoord,
): { directMeters: number; detourMeters: number } {
  const directMeters =
    haversineMeters(start.lat, start.lng, target.lat, target.lng) *
    ROAD_SINUOSITY_FACTOR;

  if (activeStops.length === 0) {
    return {
      directMeters: Math.round(directMeters),
      detourMeters: Math.round(directMeters),
    };
  }

  const chain: RouteStopCoord[] = [start, ...activeStops];
  if (anchor) chain.push(anchor);

  let bestDetour = Infinity;
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    const base = haversineMeters(a.lat, a.lng, b.lat, b.lng);
    const via =
      haversineMeters(a.lat, a.lng, target.lat, target.lng) +
      haversineMeters(target.lat, target.lng, b.lat, b.lng);
    const extra = Math.max(0, (via - base) * ROAD_SINUOSITY_FACTOR);
    if (extra < bestDetour) bestDetour = extra;
  }

  // También evaluar agregar al final de la última parada activa.
  const lastStop = activeStops[activeStops.length - 1];
  const appendDist =
    haversineMeters(lastStop.lat, lastStop.lng, target.lat, target.lng) *
    ROAD_SINUOSITY_FACTOR;
  if (appendDist < bestDetour) bestDetour = appendDist;

  return {
    directMeters: Math.round(directMeters),
    detourMeters: Math.round(Number.isFinite(bestDetour) ? bestDetour : directMeters),
  };
}

export function evaluateDriverCandidates(
  drivers: CandidateDriverInput[],
  ctx: CandidateTargetInput,
  now = Date.now(),
): {
  candidates: RankedDriverCandidate[];
  excluded: ExcludedDriverCandidate[];
} {
  const maxOrders =
    ctx.driverLimit && ctx.driverLimit > 0 ? ctx.driverLimit : DEFAULT_MAX_ORDERS;
  const eligibleRows: Array<{
    driver: CandidateDriverInput;
    gpsFresh: boolean;
    directMeters: number | null;
    detourMeters: number | null;
    etaSeconds: number | null;
    routeFit: RouteFitKind;
  }> = [];
  const excluded: ExcludedDriverCandidate[] = [];

  for (const d of drivers) {
    const failReasons: string[] = [];
    if (d.status !== 'AVAILABLE' && d.status !== 'ON_SERVICE') {
      failReasons.push(
        d.status === 'BREAK' ? 'Chofer en descanso' : 'Chofer desconectado',
      );
    }
    if (d.facilityId !== ctx.facilityId) {
      failReasons.push('Pertenece a otra sede');
    }
    if (ctx.enforceDriverLimit && d.activeLegsCount >= maxOrders) {
      failReasons.push(`Capacidad llena (${d.activeLegsCount}/${maxOrders})`);
    }
    if (failReasons.length > 0) {
      excluded.push({
        driverId: d.driverId,
        name: d.name,
        status: d.status,
        reasons: failReasons,
        locationAt: d.locationAtMs ? new Date(d.locationAtMs).toISOString() : null,
      });
      continue;
    }

    const hasValidCoords =
      d.lat !== null &&
      d.lng !== null &&
      Number.isFinite(d.lat) &&
      Number.isFinite(d.lng) &&
      !(d.lat === 0 && d.lng === 0);
    const gpsFresh = hasValidCoords && isLocationFresh(d.locationAtMs, now);

    if (!gpsFresh) {
      eligibleRows.push({
        driver: d,
        gpsFresh: false,
        directMeters: null,
        detourMeters: null,
        etaSeconds: null,
        routeFit: 'GPS_PENDING',
      });
      continue;
    }

    const { directMeters, detourMeters } = computeRouteInsertionDetour(
      { lat: d.lat as number, lng: d.lng as number },
      d.activeStops,
      ctx.target,
      ctx.facilityCoord,
    );
    const etaSeconds = Math.max(
      60,
      Math.round(directMeters / URBAN_FALLBACK_SPEED_MPS),
    );

    let routeFit: RouteFitKind;
    if (d.activeStops.length === 0) {
      routeFit = 'DIRECT';
    } else if (detourMeters <= ON_ROUTE_DETOUR_METERS) {
      routeFit = 'ON_ROUTE';
    } else if (detourMeters <= NEAR_ROUTE_DETOUR_METERS) {
      routeFit = 'NEAR_ROUTE';
    } else {
      routeFit = 'DETOUR';
    }

    eligibleRows.push({
      driver: d,
      gpsFresh: true,
      directMeters,
      detourMeters,
      etaSeconds,
      routeFit,
    });
  }

  const detours = eligibleRows
    .map((r) => r.detourMeters)
    .filter((v): v is number => v !== null);
  const minDetour = detours.length ? Math.min(...detours) : 0;
  const maxDetour = detours.length ? Math.max(...detours) : 0;

  const candidates: RankedDriverCandidate[] = eligibleRows
    .map((row) => {
      const { driver, gpsFresh, directMeters, detourMeters, etaSeconds, routeFit } =
        row;
      const zoneMatched =
        driver.authorizedZoneIds.length === 0 ||
        driver.authorizedZoneIds.includes(ctx.zoneId);

      const routeScore =
        detourMeters === null
          ? 0.25
          : maxDetour === minDetour
            ? 1
            : 1 - (detourMeters - minDetour) / (maxDetour - minDetour);
      const zoneScore = zoneMatched ? 1 : 0.4;
      const loadScore = Math.max(0, 1 - driver.activeLegsCount / maxOrders);
      const statusScore = driver.status === 'AVAILABLE' ? 1 : 0.7;

      const score = Math.round(
        (routeScore * 0.45 +
          zoneScore * 0.25 +
          loadScore * 0.2 +
          statusScore * 0.1) *
          100,
      );

      const reasons: string[] = [];
      if (routeFit === 'ON_ROUTE' && detourMeters !== null) {
        reasons.push(
          `De paso en su ruta (+${(detourMeters / 1000).toFixed(1)} km de desvío)`,
        );
      } else if (routeFit === 'NEAR_ROUTE' && detourMeters !== null) {
        reasons.push(
          `Cerca de su ruta (+${(detourMeters / 1000).toFixed(1)} km de desvío)`,
        );
      } else if (routeFit === 'DIRECT' && directMeters !== null) {
        reasons.push(`Disponible · a ${(directMeters / 1000).toFixed(1)} km`);
      } else if (routeFit === 'DETOUR' && detourMeters !== null) {
        reasons.push(
          `Desvío estimado de +${(detourMeters / 1000).toFixed(1)} km`,
        );
      } else {
        reasons.push('En sede · GPS pendiente');
      }

      if (zoneMatched) reasons.push('Zona autorizada');
      reasons.push(`Carga ${driver.activeLegsCount}/${maxOrders}`);

      return {
        driverId: driver.driverId,
        name: driver.name,
        phone: driver.phone,
        vehicle: driver.vehicle,
        plate: driver.plate,
        status: driver.status,
        eligible: true as const,
        gpsFresh,
        etaSeconds,
        distanceMeters: directMeters,
        detourMeters,
        routeFit,
        activeStopsCount: driver.activeLegsCount,
        maxOrders,
        score,
        reasons,
      };
    })
    .sort(
      (a, b) =>
        (b.gpsFresh ? 1 : 0) - (a.gpsFresh ? 1 : 0) ||
        b.score - a.score ||
        (a.detourMeters ?? Infinity) - (b.detourMeters ?? Infinity) ||
        a.driverId.localeCompare(b.driverId),
    );

  return { candidates, excluded };
}
