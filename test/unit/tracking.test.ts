import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { trackingLegFor } from '../../src/orders/tracking';

describe('trackingLegFor', () => {
  it('sigue el tramo de recogida mientras el chofer va hacia el cliente', () => {
    for (const s of ['CONFIRMED', 'PICKUP_ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_FOR_PICKUP'] as const)
      assert.equal(trackingLegFor(s), 'INBOUND', s);
  });
  it('sigue el tramo de entrega mientras la ropa va hacia el cliente', () => {
    for (const s of ['READY_FOR_DELIVERY', 'DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY', 'ARRIVED_FOR_DELIVERY'] as const)
      assert.equal(trackingLegFor(s), 'OUTBOUND', s);
  });
  it('no hay tramo activo fuera de los traslados', () => {
    for (const s of ['PAYMENT_PENDING', 'AT_FACILITY', 'IN_PROCESS', 'DELIVERED', 'CANCELLED'] as const)
      assert.equal(trackingLegFor(s), null, s);
  });
});
