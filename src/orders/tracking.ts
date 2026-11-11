import type { OrderStatus } from '../generated/prisma/client';

// Estados en los que el chofer va hacia el cliente o la ropa está en camino.
const INBOUND_TRACKED: readonly OrderStatus[] = [
  'CONFIRMED',
  'PICKUP_ASSIGNED',
  'HEADING_TO_PICKUP',
  'ARRIVED_FOR_PICKUP',
];

const OUTBOUND_TRACKED: readonly OrderStatus[] = [
  'READY_FOR_DELIVERY',
  'DELIVERY_ASSIGNED',
  'OUT_FOR_DELIVERY',
  'ARRIVED_FOR_DELIVERY',
];

// Tramo operativo que se sigue en vivo; null cuando no hay movimiento hacia el cliente.
export function trackingLegFor(status: OrderStatus): 'INBOUND' | 'OUTBOUND' | null {
  if (INBOUND_TRACKED.includes(status)) return 'INBOUND';
  if (OUTBOUND_TRACKED.includes(status)) return 'OUTBOUND';
  return null;
}
