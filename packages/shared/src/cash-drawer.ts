/**
 * Cash drawer arithmetic both the API and the clinic app must agree on.
 *
 * The API is the authority: it computes expected cash from the session's
 * events and decides the variance band a close falls into. The clinic app
 * uses the same functions to show a running total while the receptionist
 * counts, so the number on screen and the number the server records are the
 * same number by construction rather than by care.
 *
 * Every amount is an integer of minor units (0006). Each currency in a drawer
 * is counted and reconciled on its own — a euro note is not 100 lek, and a
 * drawer that "balances" only after conversion has hidden a shortage.
 */

import type { CurrencyCode } from './money';

/**
 * Notes and coins a receptionist counts, largest first, in minor units.
 *
 * Lek: banknotes 10000, 5000, 2000, 1000, 500 and 200; coins 100, 50, 20, 10,
 * 5 and 1. Euro: notes 500 to 5, coins 2 to 1 cent. The other three carry
 * their everyday circulating sets.
 */
export const DRAWER_DENOMINATIONS: Readonly<Record<CurrencyCode, readonly number[]>> = Object.freeze({
  ALL: [1_000_000, 500_000, 200_000, 100_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 100],
  EUR: [50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50, 20, 10, 5, 2, 1],
  USD: [10_000, 5_000, 2_000, 1_000, 500, 100, 25, 10, 5, 1],
  GBP: [5_000, 2_000, 1_000, 500, 200, 100, 50, 20, 10, 5, 2, 1],
  CHF: [100_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50, 20, 10, 5],
});

/** A count: denomination (minor units, as a string key) -> how many. */
export type DenominationCount = Readonly<Record<string, number>>;

/**
 * The total of a count, or null if any entry is not a whole, non-negative
 * number of a denomination this currency has. Null rather than a best effort:
 * a count the server cannot read is a count it must refuse.
 */
export function countTotal(currency: CurrencyCode, count: DenominationCount): number | null {
  const allowed = new Set(DRAWER_DENOMINATIONS[currency]);
  let total = 0;
  for (const [key, qty] of Object.entries(count)) {
    const value = Number(key);
    if (!Number.isInteger(value) || !allowed.has(value)) return null;
    if (!Number.isInteger(qty) || qty < 0 || qty > 100_000) return null;
    total += value * qty;
  }
  return total;
}

/**
 * Event types and the sign each applies to expected cash.
 *
 *   open              + the float put in the drawer
 *   cash_sale         + a cash payment taken
 *   cash_sale_voided  − a cash payment reversed while the session was open
 *   payout            − cash paid out (a courier, a supplier), approved
 *   drop              − cash moved from the drawer to the safe
 *   add_float         + cash added from the safe
 *   no_sale           0 — the drawer was opened without a sale
 *   post_close_void   0 — a cash payment from this session voided after it
 *                     closed. Recorded against the session it belongs to, and
 *                     never folded into a review that was already frozen.
 */
export const DRAWER_EVENT_SIGN = Object.freeze({
  open: 1,
  cash_sale: 1,
  cash_sale_voided: -1,
  payout: -1,
  drop: -1,
  add_float: 1,
  no_sale: 0,
  post_close_void: 0,
} as const);

export type DrawerEventType = keyof typeof DRAWER_EVENT_SIGN;
export const DRAWER_EVENT_TYPES = Object.keys(DRAWER_EVENT_SIGN) as DrawerEventType[];

export interface DrawerEventLike {
  type: DrawerEventType;
  currency: CurrencyCode;
  /** Always positive; the sign comes from the type. */
  amount: number;
}

/** Expected cash per currency from a session's events. */
export function expectedCash(
  events: readonly DrawerEventLike[],
): Partial<Record<CurrencyCode, number>> {
  const out: Partial<Record<CurrencyCode, number>> = {};
  for (const e of events) {
    const sign = DRAWER_EVENT_SIGN[e.type];
    out[e.currency] = (out[e.currency] ?? 0) + sign * e.amount;
  }
  return out;
}

export const VARIANCE_BANDS = ['exact', 'note', 'approval'] as const;
export type VarianceBand = (typeof VARIANCE_BANDS)[number];

export interface VarianceThresholds {
  /** Up to and including this absolute difference, nothing is asked. */
  tolerance: number;
  /** Above this absolute difference, a manager must approve. */
  approval: number;
}

/**
 * Which band a difference falls into. `variance` is counted minus expected:
 * positive is over, negative is short. The two directions are treated alike —
 * an unexplained overage is as much a sign of a mis-recorded payment as a
 * shortage is.
 */
export function varianceBand(variance: number, t: VarianceThresholds): VarianceBand {
  const abs = Math.abs(variance);
  if (abs <= t.tolerance) return 'exact';
  if (abs <= t.approval) return 'note';
  return 'approval';
}

/** Thresholds for a clinic that has not set its own, per currency. */
export const DEFAULT_VARIANCE_THRESHOLDS: Readonly<Record<CurrencyCode, VarianceThresholds>> =
  Object.freeze({
    ALL: { tolerance: 10_000, approval: 200_000 },
    EUR: { tolerance: 100, approval: 2_000 },
    USD: { tolerance: 100, approval: 2_000 },
    GBP: { tolerance: 100, approval: 2_000 },
    CHF: { tolerance: 100, approval: 2_000 },
  });

/** The shortest note a receptionist may give for a variance in the note band. */
export const VARIANCE_NOTE_MIN_LENGTH = 10;
