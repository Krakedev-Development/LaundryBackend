export type DriverInactivityAlertCode =
  | 'NO_SIGNAL_ON_SERVICE'
  | 'NO_SIGNAL_AVAILABLE'
  | 'STATIONARY_ON_SERVICE';

export type DriverInactivitySeverity = 'WARNING' | 'CRITICAL';

export interface AdminMapDriverAlert {
  driverId: string;
  driverName: string;
  facilityId: string;
  zoneId: string;
  status: string;
  code: DriverInactivityAlertCode;
  severity: DriverInactivitySeverity;
  message: string;
  minutesSinceSignal: number | null;
  lat: number | null;
  lng: number | null;
  detectedAt: string;
}

export interface PersistedHistorySample {
  lat: number;
  lng: number;
  timestamp: number;
}

export interface DriverInactivityCandidate {
  driverId: string;
  name: string;
  facilityId: string;
  zoneId: string;
  status: string;
  lat: number | null;
  lng: number | null;
  locationAtMs: number | null;
  lastMovedAtMs?: number | null;
  hasActiveRouteLeg?: boolean;
}

export const HISTORY_MIN_INTERVAL_MS = 15_000;
export const HISTORY_MIN_DISTANCE_METERS = 25;
export const NO_SIGNAL_ON_SERVICE_MS = 3 * 60 * 1000;
export const NO_SIGNAL_AVAILABLE_MS = 5 * 60 * 1000;
export const STATIONARY_ON_SERVICE_MS = 8 * 60 * 1000;
export const STATIONARY_RADIUS_METERS = 30;

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Decide si un nuevo punto GPS merece insertarse en `DriverLocationPoint`
 * (evita saturar PostgreSQL con puntos duplicados estando estacionado).
 */
export function shouldPersistHistoryPoint(
  previous: PersistedHistorySample | undefined,
  next: PersistedHistorySample,
): boolean {
  if (!previous) return true;
  if (next.timestamp - previous.timestamp >= HISTORY_MIN_INTERVAL_MS) return true;
  return (
    haversineMeters(previous.lat, previous.lng, next.lat, next.lng) >=
    HISTORY_MIN_DISTANCE_METERS
  );
}

/**
 * Evalúa choferes activos y produce alertas operativas cuando:
 * - ON_SERVICE sin señal GPS >= 3 min (CRITICAL)
 * - AVAILABLE sin señal GPS >= 5 min (WARNING)
 * - ON_SERVICE con tramo en ruta pero detenido >= 8 min (WARNING)
 */
export function evaluateDriverInactivityAlerts(
  drivers: DriverInactivityCandidate[],
  now = Date.now(),
): AdminMapDriverAlert[] {
  const alerts: AdminMapDriverAlert[] = [];
  const detectedAt = new Date(now).toISOString();

  for (const d of drivers) {
    if (d.status !== 'ON_SERVICE' && d.status !== 'AVAILABLE') continue;

    const signalAgeMs =
      d.locationAtMs !== null && Number.isFinite(d.locationAtMs)
        ? Math.max(0, now - d.locationAtMs)
        : null;
    const minutesSinceSignal =
      signalAgeMs !== null ? Math.floor(signalAgeMs / 60_000) : null;

    if (d.status === 'ON_SERVICE') {
      if (signalAgeMs === null || signalAgeMs >= NO_SIGNAL_ON_SERVICE_MS) {
        alerts.push({
          driverId: d.driverId,
          driverName: d.name,
          facilityId: d.facilityId,
          zoneId: d.zoneId,
          status: d.status,
          code: 'NO_SIGNAL_ON_SERVICE',
          severity: 'CRITICAL',
          message:
            minutesSinceSignal === null
              ? 'En servicio sin señal GPS registrada.'
              : `En servicio sin señal GPS hace ${minutesSinceSignal} min.`,
          minutesSinceSignal,
          lat: d.lat,
          lng: d.lng,
          detectedAt,
        });
        continue;
      }

      if (
        d.hasActiveRouteLeg &&
        d.lastMovedAtMs != null &&
        now - d.lastMovedAtMs >= STATIONARY_ON_SERVICE_MS
      ) {
        const stationaryMin = Math.floor((now - d.lastMovedAtMs) / 60_000);
        alerts.push({
          driverId: d.driverId,
          driverName: d.name,
          facilityId: d.facilityId,
          zoneId: d.zoneId,
          status: d.status,
          code: 'STATIONARY_ON_SERVICE',
          severity: 'WARNING',
          message: `Detenido sin avance en ruta hace ${stationaryMin} min.`,
          minutesSinceSignal,
          lat: d.lat,
          lng: d.lng,
          detectedAt,
        });
      }
      continue;
    }

    // AVAILABLE
    if (signalAgeMs === null || signalAgeMs >= NO_SIGNAL_AVAILABLE_MS) {
      alerts.push({
        driverId: d.driverId,
        driverName: d.name,
        facilityId: d.facilityId,
        zoneId: d.zoneId,
        status: d.status,
        code: 'NO_SIGNAL_AVAILABLE',
        severity: 'WARNING',
        message:
          minutesSinceSignal === null
            ? 'Disponible sin señal GPS registrada.'
            : `Disponible sin señal GPS hace ${minutesSinceSignal} min.`,
        minutesSinceSignal,
        lat: d.lat,
        lng: d.lng,
        detectedAt,
      });
    }
  }

  return alerts;
}
