import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { trackingLegFor } from '../../src/orders/tracking';
import {
  isLiveCustomerTrackingStatus,
  isLocationFresh,
  liveTrackingLegFor,
  validateDriverCoordinates,
} from '../../src/tracking/tracking.constants';

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

describe('liveTrackingLegFor & tracking constants', () => {
  it('activa el mapa en vivo solo cuando el chofer va hacia el domicilio del cliente', () => {
    for (const s of ['PICKUP_ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_FOR_PICKUP'] as const) {
      assert.equal(liveTrackingLegFor(s), 'INBOUND', s);
      assert.equal(isLiveCustomerTrackingStatus(s), true, s);
    }
    for (const s of ['DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY', 'ARRIVED_FOR_DELIVERY'] as const) {
      assert.equal(liveTrackingLegFor(s), 'OUTBOUND', s);
      assert.equal(isLiveCustomerTrackingStatus(s), true, s);
    }
  });

  it('oculta el mapa en vivo durante el traslado a planta, lavado y cierre', () => {
    for (const s of [
      'PAYMENT_PENDING',
      'CONFIRMED',
      'PICKED_UP',
      'HEADING_TO_FACILITY',
      'AT_FACILITY',
      'WEIGHING',
      'INSPECTION',
      'IN_PROCESS',
      'QUALITY_CONTROL',
      'READY_FOR_DELIVERY',
      'DELIVERED',
      'COMPLETED',
      'CANCELLED',
    ] as const) {
      assert.equal(liveTrackingLegFor(s), null, s);
      assert.equal(isLiveCustomerTrackingStatus(s), false, s);
    }
  });

  it('valida coordenadas GPS y frescura de ubicación', () => {
    assert.equal(validateDriverCoordinates(-2.1894, -79.8891), null);
    assert.ok(validateDriverCoordinates(0, 0));
    assert.ok(validateDriverCoordinates(95, -79.8));
    assert.ok(validateDriverCoordinates(Number.NaN, -79.8));

    const now = Date.now();
    assert.equal(isLocationFresh(now - 30_000, now), true);
    assert.equal(isLocationFresh(now - 180_000, now), false);
    assert.equal(isLocationFresh(null, now), false);
  });
});
