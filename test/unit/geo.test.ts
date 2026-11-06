import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pointInPolygon } from '../../src/geo/geo.service';

const square = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 10 },
  { lat: 10, lng: 10 },
  { lat: 10, lng: 0 },
];
// Polígono cóncavo en forma de "L".
const ell = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 10 },
  { lat: 4, lng: 10 },
  { lat: 4, lng: 4 },
  { lat: 10, lng: 4 },
  { lat: 10, lng: 0 },
];

describe('pointInPolygon', () => {
  it('detecta puntos dentro y fuera de un cuadrado', () => {
    assert.equal(pointInPolygon({ lat: 5, lng: 5 }, square), true);
    assert.equal(pointInPolygon({ lat: 11, lng: 5 }, square), false);
    assert.equal(pointInPolygon({ lat: 5, lng: -1 }, square), false);
  });
  it('respeta la concavidad', () => {
    assert.equal(pointInPolygon({ lat: 2, lng: 8 }, ell), true);
    assert.equal(pointInPolygon({ lat: 8, lng: 2 }, ell), true);
    assert.equal(pointInPolygon({ lat: 8, lng: 8 }, ell), false);
  });
});
