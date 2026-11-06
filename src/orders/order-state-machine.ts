import type {
  FulfillmentMode,
  OrderStatus,
  UserRole,
} from '../generated/prisma/client';

// Condición que debe cumplir un módulo especializado para mover el pedido. El endpoint genérico
// de transiciones solo ejecuta las de puerta NONE; las demás las dispara el módulo dueño de la
// evidencia (pago, despacho, custodia, pesaje, ajustes), de modo que no se pueda saltar la
// verificación de custodia ni de pago con una simple llamada de estado.
export type Gate =
  | 'NONE'
  | 'PAYMENT'
  | 'ASSIGNMENT'
  | 'HANDOFF'
  | 'WEIGHING'
  | 'ADJUSTMENT';

export interface Transition {
  from: OrderStatus;
  to: OrderStatus;
  roles: UserRole[];
  gate: Gate;
  // Solo aplica a ese modo de entrega.
  mode?: FulfillmentMode;
}

const STAFF: UserRole[] = ['ADMIN', 'SUPERVISOR'];

export const TRANSITIONS: readonly Transition[] = [
  { from: 'PAYMENT_PENDING', to: 'CONFIRMED', roles: STAFF, gate: 'PAYMENT' },
  { from: 'CONFIRMED', to: 'PICKUP_ASSIGNED', roles: STAFF, gate: 'ASSIGNMENT' },
  { from: 'PICKUP_ASSIGNED', to: 'HEADING_TO_PICKUP', roles: ['DRIVER'], gate: 'NONE' },
  { from: 'HEADING_TO_PICKUP', to: 'ARRIVED_FOR_PICKUP', roles: ['DRIVER'], gate: 'NONE' },
  { from: 'ARRIVED_FOR_PICKUP', to: 'PICKED_UP', roles: ['DRIVER'], gate: 'HANDOFF' },
  { from: 'PICKED_UP', to: 'HEADING_TO_FACILITY', roles: ['DRIVER'], gate: 'NONE' },
  { from: 'HEADING_TO_FACILITY', to: 'AT_FACILITY', roles: STAFF, gate: 'HANDOFF' },
  { from: 'AT_FACILITY', to: 'WEIGHING', roles: STAFF, gate: 'NONE' },
  { from: 'WEIGHING', to: 'INSPECTION', roles: STAFF, gate: 'WEIGHING' },
  { from: 'INSPECTION', to: 'PRICING_PENDING', roles: STAFF, gate: 'NONE' },
  { from: 'PRICING_PENDING', to: 'CUSTOMER_APPROVAL_PENDING', roles: STAFF, gate: 'ADJUSTMENT' },
  { from: 'PRICING_PENDING', to: 'IN_PROCESS', roles: STAFF, gate: 'ADJUSTMENT' },
  // El cliente decide cada ajuste; el personal cierra la fijación de precio.
  { from: 'CUSTOMER_APPROVAL_PENDING', to: 'IN_PROCESS', roles: STAFF, gate: 'ADJUSTMENT' },
  { from: 'IN_PROCESS', to: 'QUALITY_CONTROL', roles: STAFF, gate: 'NONE' },
  { from: 'QUALITY_CONTROL', to: 'READY_FOR_DELIVERY', roles: STAFF, gate: 'NONE', mode: 'HOME_HOME' },
  { from: 'QUALITY_CONTROL', to: 'READY_FOR_PICKUP', roles: STAFF, gate: 'NONE', mode: 'HOME_STORE' },
  { from: 'READY_FOR_DELIVERY', to: 'DELIVERY_ASSIGNED', roles: STAFF, gate: 'ASSIGNMENT' },
  // El chofer sale solo tras recibir la ropa de la sede con verificación de custodia.
  { from: 'DELIVERY_ASSIGNED', to: 'OUT_FOR_DELIVERY', roles: ['DRIVER'], gate: 'HANDOFF' },
  { from: 'OUT_FOR_DELIVERY', to: 'ARRIVED_FOR_DELIVERY', roles: ['DRIVER'], gate: 'NONE' },
  { from: 'ARRIVED_FOR_DELIVERY', to: 'DELIVERED', roles: ['DRIVER'], gate: 'HANDOFF' },
  { from: 'READY_FOR_PICKUP', to: 'DELIVERED', roles: STAFF, gate: 'HANDOFF' },
  { from: 'DELIVERED', to: 'COMPLETED', roles: STAFF, gate: 'PAYMENT' },
];

export function findTransition(
  from: OrderStatus,
  to: OrderStatus,
  mode: FulfillmentMode,
): Transition | undefined {
  return TRANSITIONS.find(
    (t) => t.from === from && t.to === to && (!t.mode || t.mode === mode),
  );
}

// Estados desde los cuales aún se puede cancelar (la ropa no ha sido entregada al chofer).
export const CLIENT_CANCELLABLE: readonly OrderStatus[] = [
  'PAYMENT_PENDING',
  'CONFIRMED',
  'PICKUP_ASSIGNED',
];
export const STAFF_CANCELLABLE: readonly OrderStatus[] = [
  ...CLIENT_CANCELLABLE,
  'HEADING_TO_PICKUP',
  'ARRIVED_FOR_PICKUP',
];

// Estados en que la ropa está en manos de la recogida (tramo INBOUND) o de la entrega (OUTBOUND).
const INBOUND_STATES: readonly OrderStatus[] = [
  'PICKUP_ASSIGNED',
  'HEADING_TO_PICKUP',
  'ARRIVED_FOR_PICKUP',
  'PICKED_UP',
  'HEADING_TO_FACILITY',
];
export const legKindFor = (status: OrderStatus): 'INBOUND' | 'OUTBOUND' =>
  INBOUND_STATES.includes(status) ? 'INBOUND' : 'OUTBOUND';
