import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateDriverInactivityAlerts,
  haversineMeters,
  HISTORY_MIN_INTERVAL_MS,
  NO_SIGNAL_AVAILABLE_MS,
  NO_SIGNAL_ON_SERVICE_MS,
  shouldPersistHistoryPoint,
  STATIONARY_ON_SERVICE_MS,
} from '../../src/tracking/driver-inactivity.util';

describe('driver-inactivity.util', () => {
  it('muestrea puntos históricos respetando intervalo mínimo (15 s) y distancia mínima (25 m)', () => {
    const t0 = 1_700_000_000_000;
    const p0 = { lat: -2.145, lng: -79.865, timestamp: t0 };

    assert.equal(shouldPersistHistoryPoint(undefined, p0), true);

    // Mismo sitio 5 s después -> descartado
    assert.equal(
      shouldPersistHistoryPoint(p0, { lat: -2.145, lng: -79.865, timestamp: t0 + 5_000 }),
      false,
    );

    // Mismo sitio >= 15 s después -> guardado
    assert.equal(
      shouldPersistHistoryPoint(p0, {
        lat: -2.145,
        lng: -79.865,
        timestamp: t0 + HISTORY_MIN_INTERVAL_MS,
      }),
      true,
    );

    // Desplazamiento > 25 m en 3 s -> guardado
    assert.equal(
      shouldPersistHistoryPoint(p0, {
        lat: -2.1455,
        lng: -79.865,
        timestamp: t0 + 3_000,
      }),
      true,
    );
    assert.ok(haversineMeters(-2.145, -79.865, -2.1455, -79.865) > 25);
  });

  it('detecta alertas de chofer inactivo (ON_SERVICE crítico, AVAILABLE advertencia y estacionado en ruta)', () => {
    const now = 1_700_000_600_000;
    const alerts = evaluateDriverInactivityAlerts(
      [
        {
          driverId: 'd-1',
          name: 'Chofer En Servicio Sin Señal',
          facilityId: 'fac-1',
          zoneId: 'zone-1',
          status: 'ON_SERVICE',
          lat: -2.14,
          lng: -79.86,
          locationAtMs: now - NO_SIGNAL_ON_SERVICE_MS - 60_000,
        },
        {
          driverId: 'd-2',
          name: 'Chofer Disponible Sin Señal',
          facilityId: 'fac-1',
          zoneId: 'zone-1',
          status: 'AVAILABLE',
          lat: -2.15,
          lng: -79.87,
          locationAtMs: now - NO_SIGNAL_AVAILABLE_MS - 120_000,
        },
        {
          driverId: 'd-3',
          name: 'Chofer Estacionado En Ruta',
          facilityId: 'fac-2',
          zoneId: 'zone-2',
          status: 'ON_SERVICE',
          lat: -2.16,
          lng: -79.88,
          locationAtMs: now - 10_000,
          lastMovedAtMs: now - STATIONARY_ON_SERVICE_MS - 60_000,
          hasActiveRouteLeg: true,
        },
        {
          driverId: 'd-4',
          name: 'Chofer Activo Normal',
          facilityId: 'fac-1',
          zoneId: 'zone-1',
          status: 'ON_SERVICE',
          lat: -2.14,
          lng: -79.86,
          locationAtMs: now - 15_000,
          lastMovedAtMs: now - 20_000,
          hasActiveRouteLeg: true,
        },
        {
          driverId: 'd-5',
          name: 'Chofer Offline',
          facilityId: 'fac-1',
          zoneId: 'zone-1',
          status: 'OFFLINE',
          lat: null,
          lng: null,
          locationAtMs: null,
        },
      ],
      now,
    );

    assert.equal(alerts.length, 3);
    assert.equal(alerts[0].code, 'NO_SIGNAL_ON_SERVICE');
    assert.equal(alerts[0].severity, 'CRITICAL');
    assert.equal(alerts[1].code, 'NO_SIGNAL_AVAILABLE');
    assert.equal(alerts[1].severity, 'WARNING');
    assert.equal(alerts[2].code, 'STATIONARY_ON_SERVICE');
    assert.equal(alerts[2].severity, 'WARNING');
  });
});
