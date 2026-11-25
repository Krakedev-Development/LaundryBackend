import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { trackingLegFor } from '../../src/orders/tracking';
import type { ConfigService } from '@nestjs/config';
import { isSocketOriginAllowed } from '../../src/tracking/configured-io.adapter';
import { MapboxDirectionsService, ROAD_SINUOSITY_FACTOR } from '../../src/tracking/mapbox-directions.service';
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

describe('isSocketOriginAllowed', () => {
  it('acepta las apps nativas (sin origen) y solo los navegadores de CORS_ORIGINS', () => {
    const allowed = ['http://localhost:3000', 'http://localhost:8081'];
    assert.equal(isSocketOriginAllowed(undefined, allowed), true);
    assert.equal(isSocketOriginAllowed('http://localhost:3000', allowed), true);
    assert.equal(isSocketOriginAllowed('http://ajeno.test', allowed), false);
    assert.equal(isSocketOriginAllowed('http://localhost:3000', []), false);
  });
});

describe('MapboxDirectionsService (respaldo de rutas)', () => {
  const service = (env: Record<string, string>) =>
    new MapboxDirectionsService({ get: (k: string) => env[k] } as unknown as ConfigService);
  const origin = { latitude: 0, longitude: 0 };
  const destination = { latitude: 0, longitude: 0.01 }; // ~1112 m en línea recta

  it('sin Mapbox ni OSRM_URL no consulta la red y estima 1.3 veces la línea recta a 25 km/h', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('sin red');
    }) as typeof fetch;
    const s = service({});
    try {
      const route = await s.getRouteWithGeometry(origin, destination);
      assert.equal(calls, 0);
      assert.equal(ROAD_SINUOSITY_FACTOR, 1.3);
      assert.deepEqual([route.provider, route.isFallback], ['fallback', true]);
      assert.equal(route.distanceMeters, Math.round(1112 * 1.3));
      assert.equal(route.durationSeconds, Math.round(route.distanceMeters / ((25 * 1000) / 3600)));
    } finally {
      globalThis.fetch = original;
      s.onModuleDestroy();
    }
  });

  it('con OSRM_URL usa ese servidor como respaldo', async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({ routes: [{ distance: 1500, duration: 300, geometry: { coordinates: [[0, 0], [0.01, 0]] } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const s = service({ OSRM_URL: 'http://osrm.interno:5000/' });
    try {
      const route = await s.getRouteWithGeometry(origin, destination);
      assert.equal(urls.length, 1);
      assert.ok(urls[0].startsWith('http://osrm.interno:5000/route/v1/driving/'), urls[0]);
      assert.deepEqual([route.provider, route.distanceMeters], ['osrm', 1500]);
    } finally {
      globalThis.fetch = original;
      s.onModuleDestroy();
    }
  });
});
