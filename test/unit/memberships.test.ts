import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  currentWeekStart,
  effectiveMembershipStatus,
  isMembershipActive,
  membershipPeriodDays,
} from '../../src/customers/membership.util';

describe('membership.util', () => {
  it('devuelve los días por periodicidad', () => {
    assert.equal(membershipPeriodDays('MONTHLY'), 30);
    assert.equal(membershipPeriodDays('QUARTERLY'), 90);
    assert.equal(membershipPeriodDays('YEARLY'), 365);
  });

  it('determina si una membresía está activa según estado y expiración', () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const future = new Date('2026-12-27T12:00:00Z');
    const past = new Date('2026-11-26T12:00:00Z');

    assert.equal(isMembershipActive({ membershipPlanId: null }, now), false);
    assert.equal(
      isMembershipActive(
        { membershipPlanId: 'p1', membershipStatus: 'ACTIVE', membershipExpiresAt: future },
        now,
      ),
      true,
    );
    assert.equal(
      isMembershipActive(
        { membershipPlanId: 'p1', membershipStatus: 'ACTIVE', membershipExpiresAt: past },
        now,
      ),
      false,
    );
    assert.equal(
      isMembershipActive(
        { membershipPlanId: 'p1', membershipStatus: 'CANCELLED', membershipExpiresAt: future },
        now,
      ),
      false,
    );
    assert.equal(
      effectiveMembershipStatus(
        { membershipPlanId: 'p1', membershipStatus: 'ACTIVE', membershipExpiresAt: past },
        now,
      ),
      'EXPIRED',
    );
  });

  it('calcula el inicio de semana operativa (lunes 00:00 en zona horaria)', () => {
    // 2026-11-27 es viernes en America/Guayaquil (UTC-5) -> lunes fue 2026-11-23 00:00 -05:00 = 05:00Z
    const friday = new Date('2026-11-27T16:00:00Z');
    assert.equal(
      currentWeekStart('America/Guayaquil', friday).toISOString(),
      '2026-11-23T05:00:00.000Z',
    );
    // Domingo 2026-11-29 en America/Guayaquil sigue perteneciendo a la semana del lunes 2026-11-23
    const sunday = new Date('2026-11-29T23:00:00Z');
    assert.equal(
      currentWeekStart('America/Guayaquil', sunday).toISOString(),
      '2026-11-23T05:00:00.000Z',
    );
  });
});
