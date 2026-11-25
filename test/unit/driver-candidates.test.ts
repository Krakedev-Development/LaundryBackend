import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeRouteInsertionDetour,
  evaluateDriverCandidates,
} from '../../src/orders/driver-candidates.util';

const FACILITY = { lat: -2.1304, lng: -79.8656 }; // Local Samborondón
const TARGET = { lat: -2.145, lng: -79.865 }; // Av. Samborondón

describe('driver-candidates.util', () => {
  it('detecta cuando un pedido queda de paso en la ruta activa del chofer (desvío mínimo)', () => {
    const start = { lat: -2.16, lng: -79.865 };
    const stop1 = { lat: -2.13, lng: -79.865 };
    // TARGET (-2.145, -79.865) está exactamente en línea entre start y stop1!
    const { detourMeters } = computeRouteInsertionDetour(
      start,
      [stop1],
      TARGET,
      FACILITY,
    );
    assert.ok(
      detourMeters < 200,
      `Se esperaba desvío casi cero y dio ${detourMeters} m`,
    );
  });

  it('ordena mejor al chofer cuya ruta pasa por el pedido y excluye inactivos o de otra sede', () => {
    const now = 1_700_000_000_000;
    const { candidates, excluded } = evaluateDriverCandidates(
      [
        {
          driverId: 'd-on-route',
          name: 'Chofer De Paso',
          phone: null,
          vehicle: 'Van',
          plate: 'ABC-111',
          status: 'ON_SERVICE',
          facilityId: 'fac-1',
          authorizedZoneIds: ['zone-1'],
          lat: -2.16,
          lng: -79.865,
          locationAtMs: now - 10_000,
          activeStops: [{ lat: -2.13, lng: -79.865 }],
          activeLegsCount: 1,
        },
        {
          driverId: 'd-far',
          name: 'Chofer Lejano',
          phone: null,
          vehicle: 'Moto',
          plate: 'ABC-222',
          status: 'ON_SERVICE',
          facilityId: 'fac-1',
          authorizedZoneIds: ['zone-1'],
          lat: -2.21,
          lng: -79.92,
          locationAtMs: now - 10_000,
          activeStops: [{ lat: -2.22, lng: -79.93 }],
          activeLegsCount: 1,
        },
        {
          driverId: 'd-no-gps',
          name: 'Chofer Sin GPS',
          phone: null,
          vehicle: 'Van',
          plate: 'ABC-333',
          status: 'AVAILABLE',
          facilityId: 'fac-1',
          authorizedZoneIds: ['zone-1'],
          lat: null,
          lng: null,
          locationAtMs: null,
          activeStops: [],
          activeLegsCount: 0,
        },
        {
          driverId: 'd-offline',
          name: 'Chofer Offline',
          phone: null,
          vehicle: 'Van',
          plate: 'ABC-444',
          status: 'OFFLINE',
          facilityId: 'fac-1',
          authorizedZoneIds: ['zone-1'],
          lat: -2.14,
          lng: -79.86,
          locationAtMs: now - 5_000,
          activeStops: [],
          activeLegsCount: 0,
        },
        {
          driverId: 'd-other-fac',
          name: 'Chofer Otra Sede',
          phone: null,
          vehicle: 'Van',
          plate: 'ABC-555',
          status: 'AVAILABLE',
          facilityId: 'fac-2',
          authorizedZoneIds: ['zone-2'],
          lat: -2.14,
          lng: -79.86,
          locationAtMs: now - 5_000,
          activeStops: [],
          activeLegsCount: 0,
        },
      ],
      {
        facilityId: 'fac-1',
        zoneId: 'zone-1',
        target: TARGET,
        facilityCoord: FACILITY,
        enforceDriverLimit: true,
        driverLimit: 5,
      },
      now,
    );

    assert.equal(excluded.length, 2);
    assert.equal(candidates.length, 3);
    assert.equal(candidates[0].driverId, 'd-on-route');
    assert.equal(candidates[0].routeFit, 'ON_ROUTE');
    assert.equal(candidates[2].driverId, 'd-no-gps');
    assert.equal(candidates[2].etaSeconds, null);
    assert.equal(candidates[2].routeFit, 'GPS_PENDING');
  });
});
