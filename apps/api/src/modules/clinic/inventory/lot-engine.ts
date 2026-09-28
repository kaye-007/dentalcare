import { parseQuantity } from './stock-engine';

/**
 * Lots and expiry, with no database and no Nest in it — the same reasoning as
 * stock-engine.ts.
 *
 * ── Dates ─────────────────────────────────────────────────────────────────
 *
 * Every date here is an ISO calendar date, "2026-09-14", and `today` is always
 * passed in. The service takes it from the database's clinic_today() — the
 * date on the clinic's clock, not the server's — so the list, the alerts and
 * the refusal to use an expired lot all agree, and a test can say what day it
 * is.
 *
 * A lot is usable ON its expiry date and expired from the day after. That is
 * how the date on a packet is read.
 *
 * ── Which lot, when nobody says ───────────────────────────────────────────
 *
 * First-expiry-first-out. Recording "used two cartridges" at the front desk
 * should not require reading a lot number off a box; the lot most likely to
 * be wasted is the one to use first, and it is also the one a person would
 * reach for. A lot is only picked when it can cover the whole amount: quietly
 * splitting one usage across two lots would make a recall list claim a patient
 * received both.
 */

export type ExpiryState = 'none' | 'ok' | 'expiring' | 'expired';
export type LotStatus = 'active' | 'recalled';

export interface LotCandidate {
  id: string;
  lotNumber: string;
  expiresOn: string | null;
  receivedOn: string;
  quantity: number;
  status: LotStatus;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** A real calendar date in ISO form. "2026-02-30" is not one. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

function dayNumber(iso: string): number {
  if (!isIsoDate(iso)) throw new RangeError(`Not a date: ${iso}`);
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** Whole days from `today` until `expiresOn`. Zero on the day; negative after. */
export function daysUntil(expiresOn: string, today: string): number {
  return dayNumber(expiresOn) - dayNumber(today);
}

/**
 * Where a lot stands. `warningDays` is the item's own window: a year's notice
 * matters for implants and a fortnight's for gloves.
 */
export function expiryState(
  expiresOn: string | null,
  today: string,
  warningDays: number,
): ExpiryState {
  if (!expiresOn) return 'none';
  const days = daysUntil(expiresOn, today);
  if (days < 0) return 'expired';
  if (days <= warningDays) return 'expiring';
  return 'ok';
}

/** Why this lot may not be used on a patient today, or null if it may. */
export function usageBlocker(lot: LotCandidate, today: string): string | null {
  if (lot.status === 'recalled') {
    return `Lot ${lot.lotNumber} has been recalled and cannot be used on a patient. Write it off instead.`;
  }
  if (lot.expiresOn && daysUntil(lot.expiresOn, today) < 0) {
    return `Lot ${lot.lotNumber} expired on ${lot.expiresOn} and cannot be used on a patient. Write it off instead.`;
  }
  return null;
}

/** Whole hundredths, so comparisons match numeric(12,2) exactly. */
const hundredths = (q: number) => Math.round(parseQuantity(q) * 100);

/** Earliest expiry first; no expiry last; then oldest received; then by number. */
function fefo(a: LotCandidate, b: LotCandidate): number {
  if (a.expiresOn !== b.expiresOn) {
    if (a.expiresOn === null) return 1;
    if (b.expiresOn === null) return -1;
    return a.expiresOn < b.expiresOn ? -1 : 1;
  }
  if (a.receivedOn !== b.receivedOn) return a.receivedOn < b.receivedOn ? -1 : 1;
  return a.lotNumber.localeCompare(b.lotNumber);
}

/**
 * The lot a usage of `amount` should come from when none was chosen.
 *
 * Throws a RangeError phrased for a person when there is no single usable lot
 * that covers it.
 */
export function pickLot(
  lots: readonly LotCandidate[],
  amount: number,
  today: string,
): LotCandidate {
  const wanted = hundredths(amount);
  const withStock = lots.filter((l) => hundredths(l.quantity) > 0);
  const usable = withStock.filter((l) => usageBlocker(l, today) === null).sort(fefo);

  const pick = usable.find((l) => hundredths(l.quantity) >= wanted);
  if (pick) return pick;

  if (usable.length > 0) {
    const largest = Math.max(...usable.map((l) => hundredths(l.quantity))) / 100;
    throw new RangeError(
      `No single lot holds ${amount}. Choose the lot, or record the usage in parts — ` +
        `the largest usable lot has ${largest}.`,
    );
  }
  if (withStock.length > 0) {
    throw new RangeError(
      'Every lot with stock left is expired or recalled. Write those off, and receive new stock before using it.',
    );
  }
  throw new RangeError('There is no stock of this item in any lot.');
}
