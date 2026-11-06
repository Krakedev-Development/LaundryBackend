import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nowIn } from '../../src/slots/slots.service';

describe('nowIn', () => {
  const instant = new Date('2026-03-01T03:30:00.000Z');
  it('convierte a la zona horaria indicada, incluso si cambia el día', () => {
    assert.deepEqual(nowIn('America/Bogota', instant), { date: '2026-02-28', time: '22:30' });
    assert.deepEqual(nowIn('UTC', instant), { date: '2026-03-01', time: '03:30' });
  });
});
