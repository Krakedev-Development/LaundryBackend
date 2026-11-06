import type {
  FulfillmentMode,
  HandoffType,
  OrderStatus,
} from '../generated/prisma/client';

// Reglas de custodia. Quien presenta el código/QR lo muestra; quien verifica lo valida y, si es
// correcto, la verificación mueve el pedido (puerta HANDOFF de la máquina de estados).
// El cliente siempre presenta cuando hay un traspaso con él: así solo se entrega o se recibe la
// ropa frente a la persona correcta. Entre chofer y sede, presenta el chofer y verifica la sede.
export interface HandoffRule {
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  presenter: 'CLIENT' | 'DRIVER';
  verifier: 'DRIVER' | 'STAFF';
  // Tramo del que debe ser responsable el chofer involucrado.
  leg?: 'INBOUND' | 'OUTBOUND';
  mode?: FulfillmentMode;
}

export const HANDOFF_RULES: Record<HandoffType, HandoffRule> = {
  CUSTOMER_TO_DRIVER: {
    fromStatus: 'ARRIVED_FOR_PICKUP',
    toStatus: 'PICKED_UP',
    presenter: 'CLIENT',
    verifier: 'DRIVER',
    leg: 'INBOUND',
  },
  DRIVER_TO_FACILITY: {
    fromStatus: 'HEADING_TO_FACILITY',
    toStatus: 'AT_FACILITY',
    presenter: 'DRIVER',
    verifier: 'STAFF',
    leg: 'INBOUND',
  },
  FACILITY_TO_DRIVER: {
    fromStatus: 'DELIVERY_ASSIGNED',
    toStatus: 'OUT_FOR_DELIVERY',
    presenter: 'DRIVER',
    verifier: 'STAFF',
    leg: 'OUTBOUND',
  },
  DRIVER_TO_CUSTOMER: {
    fromStatus: 'ARRIVED_FOR_DELIVERY',
    toStatus: 'DELIVERED',
    presenter: 'CLIENT',
    verifier: 'DRIVER',
    leg: 'OUTBOUND',
    mode: 'HOME_HOME',
  },
  FACILITY_TO_CUSTOMER: {
    fromStatus: 'READY_FOR_PICKUP',
    toStatus: 'DELIVERED',
    presenter: 'CLIENT',
    verifier: 'STAFF',
    mode: 'HOME_STORE',
  },
};
