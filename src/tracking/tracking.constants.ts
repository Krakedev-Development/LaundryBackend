import type { OrderStatus } from '../generated/prisma/client';

/**
 * Estados en los que el chofer está asignado y acercándose (o esperando) en el domicilio
 * del cliente. En estos estados el cliente ve el mapa en vivo, la ruta hacia su domicilio
 * y el ETA actualizado.
 *
 * Regla de privacidad/negocio: durante PICKED_UP, HEADING_TO_FACILITY, AT_FACILITY,
 * IN_PROCESS, DELIVERED, etc., el seguimiento en vivo hacia el cliente NO está activo.
 */
export const INBOUND_LIVE_TRACKING_STATUSES: readonly OrderStatus[] = [
  'PICKUP_ASSIGNED',
  'HEADING_TO_PICKUP',
  'ARRIVED_FOR_PICKUP',
];

export const OUTBOUND_LIVE_TRACKING_STATUSES: readonly OrderStatus[] = [
  'DELIVERY_ASSIGNED',
  'OUT_FOR_DELIVERY',
  'ARRIVED_FOR_DELIVERY',
];

export const CUSTOMER_LIVE_TRACKING_STATUSES: readonly OrderStatus[] = [
  ...INBOUND_LIVE_TRACKING_STATUSES,
  ...OUTBOUND_LIVE_TRACKING_STATUSES,
];

export function liveTrackingLegFor(
  status: OrderStatus,
): 'INBOUND' | 'OUTBOUND' | null {
  if (INBOUND_LIVE_TRACKING_STATUSES.includes(status)) return 'INBOUND';
  if (OUTBOUND_LIVE_TRACKING_STATUSES.includes(status)) return 'OUTBOUND';
  return null;
}

export function isLiveCustomerTrackingStatus(status: OrderStatus): boolean {
  return liveTrackingLegFor(status) !== null;
}

export function validateDriverCoordinates(
  lat: unknown,
  lng: unknown,
): string | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return 'Coordenadas deben ser numéricas';
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return 'Coordenadas inválidas (NaN/Infinity)';
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return 'Coordenadas fuera de rango geográfico';
  }
  if (lat === 0 && lng === 0) {
    return 'Coordenadas nulas (0, 0) rechazadas';
  }
  return null;
}

export interface LiveDriverLocation {
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  timestamp: number;
}

export const DRIVER_LOCATION_FRESH_MAX_AGE_MS = 120_000;

export function isLocationFresh(
  locationAt: Date | number | null | undefined,
  now = Date.now(),
  maxAgeMs = DRIVER_LOCATION_FRESH_MAX_AGE_MS,
): boolean {
  if (locationAt == null) return false;
  const ts = locationAt instanceof Date ? locationAt.getTime() : locationAt;
  if (!Number.isFinite(ts)) return false;
  return now - ts <= maxAgeMs;
}
