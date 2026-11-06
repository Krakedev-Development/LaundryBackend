import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zonedToUtc } from '../../src/common/time';

describe('zonedToUtc', () => {
  it('zona sin horario de verano (Bogotá, UTC-5)', () => {
    assert.equal(zonedToUtc('2026-03-01', '09:00', 'America/Bogota').toISOString(), '2026-03-01T14:00:00.000Z');
  });
  it('respeta el horario de verano (Nueva York)', () => {
    assert.equal(zonedToUtc('2026-01-15', '09:00', 'America/New_York').toISOString(), '2026-01-15T14:00:00.000Z');
    assert.equal(zonedToUtc('2026-07-15', '09:00', 'America/New_York').toISOString(), '2026-07-15T13:00:00.000Z');
  });
  it('cruza de día al convertir', () => {
    assert.equal(zonedToUtc('2026-03-01', '22:30', 'America/Bogota').toISOString(), '2026-03-02T03:30:00.000Z');
  });
});
