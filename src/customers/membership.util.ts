import { zonedToUtc } from '../common/time';
import type { MembershipInterval, MembershipStatus } from '../generated/prisma/client';

const PERIOD_DAYS: Record<MembershipInterval, number> = {
  MONTHLY: 30,
  QUARTERLY: 90,
  YEARLY: 365,
};

export function membershipPeriodDays(interval: MembershipInterval = 'MONTHLY'): number {
  return PERIOD_DAYS[interval] ?? 30;
}

export function isMembershipActive(
  c: {
    membershipPlanId: string | null;
    membershipStatus?: MembershipStatus | string | null;
    membershipExpiresAt?: Date | null;
  },
  now = new Date(),
): boolean {
  if (!c.membershipPlanId) return false;
  if (c.membershipStatus && c.membershipStatus !== 'ACTIVE') return false;
  if (c.membershipExpiresAt && c.membershipExpiresAt <= now) return false;
  return true;
}

export function effectiveMembershipStatus(
  c: {
    membershipPlanId: string | null;
    membershipStatus?: MembershipStatus | null;
    membershipExpiresAt?: Date | null;
  },
  now = new Date(),
): MembershipStatus | null {
  if (!c.membershipPlanId) {
    return c.membershipStatus === 'CANCELLED' || c.membershipStatus === 'EXPIRED'
      ? c.membershipStatus
      : null;
  }
  if (c.membershipStatus && c.membershipStatus !== 'ACTIVE') {
    return c.membershipStatus;
  }
  if (c.membershipExpiresAt && c.membershipExpiresAt <= now) {
    return 'EXPIRED';
  }
  return 'ACTIVE';
}

/**
 * Inicio de la semana operativa actual (lunes 00:00 en la zona horaria indicada),
 * devuelto como instante UTC para consultar órdenes de la semana.
 */
export function currentWeekStart(timezone = 'UTC', now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const y = get('year');
  const m = get('month');
  const d = get('day');
  // Day of week in UTC for that wall-clock date (0=Sun..6=Sat)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const offsetDays = dow === 0 ? 6 : dow - 1;
  const monday = new Date(Date.UTC(y, m - 1, d - offsetDays));
  const ymd = monday.toISOString().slice(0, 10);
  return zonedToUtc(ymd, '00:00', timezone);
}
