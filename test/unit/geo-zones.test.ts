import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildZoneSpatialIndex,
  isPointInBoundingBox,
  isPointInPolygon,
  validatePolygonGeometry,
} from '../../src/geo/geo-spatial.util';
import { ActiveZonesSpatialIndexProvider } from '../../src/geo/active-zones-spatial-index.provider';
import { GeoService } from '../../src/geo/geo.service';

const SAMBORONDON_POLY = [
  { lat: -2.10, lng: -79.90 },
  { lat: -2.10, lng: -79.82 },
  { lat: -2.18, lng: -79.82 },
  { lat: -2.18, lng: -79.90 },
];

describe('geo-spatial.util', () => {
  it('detecta puntos dentro y fuera con Bounding Box y Ray-Casting', () => {
    const idx = buildZoneSpatialIndex('zone-1', 'Samborondón', SAMBORONDON_POLY);
    assert.ok(idx);
    assert.equal(isPointInBoundingBox(-2.14, -79.86, idx.bbox), true);
    assert.equal(isPointInBoundingBox(-0.18, -78.48, idx.bbox), false);
    assert.equal(isPointInPolygon(-2.14, -79.86, SAMBORONDON_POLY), true);
    assert.equal(isPointInPolygon(-2.25, -79.95, SAMBORONDON_POLY), false);
  });

  it('rechaza polígonos degenerados o auto-intersecados', () => {
    // Menos de 3 vértices
    assert.ok(validatePolygonGeometry([{ lat: -2.1, lng: -79.8 }, { lat: -2.2, lng: -79.9 }]));
    // Colineales (área 0)
    assert.ok(
      validatePolygonGeometry([
        { lat: -2.1, lng: -79.8 },
        { lat: -2.2, lng: -79.8 },
        { lat: -2.3, lng: -79.8 },
      ]),
    );
    // Auto-intersecado (reloj de arena)
    assert.ok(
      validatePolygonGeometry([
        { lat: -2.10, lng: -79.90 },
        { lat: -2.18, lng: -79.82 },
        { lat: -2.10, lng: -79.82 },
        { lat: -2.18, lng: -79.90 },
      ]),
    );
    // Válido
    assert.equal(validatePolygonGeometry(SAMBORONDON_POLY), null);
  });
});

describe('ActiveZonesSpatialIndexProvider', () => {
  it('cachea zonas activas e invalida inmediatamente tras escritura', async () => {
    let dbCalls = 0;
    const fakePrisma = {
      zone: {
        findMany: async () => {
          dbCalls += 1;
          return [
            { id: 'z-1', name: 'Samborondón', polygon: SAMBORONDON_POLY },
          ];
        },
      },
    };
    const provider = new ActiveZonesSpatialIndexProvider(fakePrisma as never);

    assert.equal(await provider.findZoneIdForPoint(-2.14, -79.86), 'z-1');
    assert.equal(await provider.findZoneIdForPoint(-2.15, -79.85), 'z-1');
    assert.equal(dbCalls, 1, 'debe reutilizar la caché en memoria');

    provider.invalidate();
    assert.equal(await provider.findZoneIdForPoint(-2.14, -79.86), 'z-1');
    assert.equal(dbCalls, 2, 'debe recargar tras invalidate()');
  });
});

describe('GeoService reglas Zona <-> Sede', () => {
  it('rechaza crear una sede fuera del polígono de su zona', async () => {
    const fakePrisma = {
      zone: {
        findUnique: async () => ({
          id: 'z-1',
          name: 'Samborondón',
          active: true,
          polygon: SAMBORONDON_POLY,
        }),
      },
    };
    const service = new GeoService(fakePrisma as never);
    await assert.rejects(
      () =>
        service.createFacility(
          { id: 'admin-1', role: 'ADMIN', email: 'a@b.c' } as never,
          {
            zoneId: 'z-1',
            name: 'Sede Fuera',
            address: 'Quito',
            latitude: -0.18,
            longitude: -78.48,
          },
        ),
      /dentro del polígono/i,
    );
  });

  it('rechaza editar polígono de zona si deja una sede vinculada fuera', async () => {
    const fakePrisma = {
      zone: {
        findUnique: async () => ({
          id: 'z-1',
          name: 'Samborondón',
          active: true,
          polygon: SAMBORONDON_POLY,
        }),
      },
      facility: {
        findMany: async () => [
          { id: 'f-1', name: 'Sede Norte', latitude: -2.14, longitude: -79.86 },
        ],
      },
    };
    const service = new GeoService(fakePrisma as never);
    await assert.rejects(
      () =>
        service.updateZone(
          { id: 'admin-1', role: 'ADMIN', email: 'a@b.c' } as never,
          'z-1',
          {
            polygon: [
              { lat: -2.00, lng: -79.80 },
              { lat: -2.00, lng: -79.75 },
              { lat: -2.05, lng: -79.75 },
              { lat: -2.05, lng: -79.80 },
            ],
          },
        ),
      /dejaría fuera de la zona/i,
    );
  });
});
