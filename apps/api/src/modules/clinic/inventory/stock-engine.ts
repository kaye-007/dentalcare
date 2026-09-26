/**
 * The arithmetic of a stock movement, with no database and no Nest in it.
 *
 * Everything here is a pure function for the same reason `billing-engine` and
 * `cost-engine` are: the quantity on a shelf is the sort of number that is
 * quietly wrong for months, and the cheapest place to prove it is right is a
 * unit test that needs nothing running.
 *
 * ── Why the caller never sends a signed number ───────────────────────────
 *
 * A clinic does not think in deltas. It thinks in four sentences:
 *
 *   "five boxes arrived"          receipt    ->  +5
 *   "I used two"                  usage      ->  -2
 *   "three were past their date"  write_off  ->  -3
 *   "I counted the shelf: eight"  adjustment ->  8 - whatever we thought
 *
 * So the API takes the sentence, not the sign. `receipt`, `usage` and
 * `write_off` carry a positive `amount` and this decides the direction;
 * `adjustment` carries the number actually counted and the delta falls out of
 * the difference. That last one is the important one: asking someone doing a
 * stock count to compute "minus two" against a figure they already believe is
 * wrong is how a count gets entered backwards.
 *
 * The database enforces the same rule from below — 0002's
 * `stock_movement_direction` CHECK refuses a `usage` that adds stock — so a
 * bug here fails at the write instead of silently inflating a shelf.
 *
 * ── Why hundredths ───────────────────────────────────────────────────────
 *
 * The column is numeric(12,2) and quantities are genuinely fractional: half a
 * bottle, 2.5 metres. Doing that arithmetic in float64 gives you
 * 0.1 + 0.2 = 0.30000000000000004, which reaches the database as a value that
 * does not equal what anyone typed. Every operation below converts to integer
 * hundredths first, so the result is exact at the precision the column
 * stores.
 */

/** What a movement means. Mirrors the CHECK constraint in migration 0002. */
export const MOVEMENT_KINDS = ['receipt', 'usage', 'adjustment', 'write_off'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** Kinds whose direction is fixed, and which way each goes. */
const DIRECTION: Readonly<Record<Exclude<MovementKind, 'adjustment'>, 1 | -1>> =
  Object.freeze({
    receipt: 1,
    usage: -1,
    write_off: -1,
  });

/** Largest quantity numeric(12,2) can hold: 10 digits before the point. */
export const MAX_QUANTITY = 9_999_999_999.99;

export function isMovementKind(value: unknown): value is MovementKind {
  return (
    typeof value === 'string' && (MOVEMENT_KINDS as readonly string[]).includes(value)
  );
}

/** Exact to two decimal places, which is the precision the column stores. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError('Quantity must be a finite number');
  }
  // Math.round(x * 100) alone is wrong for values like 1.005, where the
  // float64 nearest to 1.005 is fractionally below it. The epsilon nudge is
  // applied in the direction of the value's own sign so negatives round the
  // same way positives do.
  const scaled = value * 100;
  const nudged =
    scaled >= 0
      ? scaled + Number.EPSILON * Math.abs(scaled)
      : scaled - Number.EPSILON * Math.abs(scaled);
  return Math.round(nudged) / 100;
}

/** Whole hundredths, for arithmetic that must not drift. */
function hundredths(value: number): number {
  return Math.round(round2(value) * 100);
}

/**
 * A quantity that arrived from the outside world: a request body, or a
 * numeric column that node-postgres hands back as a string.
 */
export function parseQuantity(value: unknown, label = 'Quantity'): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new RangeError(`${label} must be a number`);
  }
  if (Math.abs(n) > MAX_QUANTITY) {
    throw new RangeError(`${label} is larger than this system can store`);
  }
  return round2(n);
}

export interface MovementRequest {
  kind: MovementKind;
  /** For receipt, usage and write_off. Always positive — the kind has the sign. */
  amount?: number;
  /** For adjustment only: what was actually on the shelf when counted. */
  countedQuantity?: number;
}

/**
 * The signed change this movement makes to the running total.
 *
 * Throws rather than returning a sentinel: every caller has to handle the
 * failure, and a silent zero would record a movement that changed nothing.
 */
export function deltaFor(request: MovementRequest, currentQuantity: number): number {
  const current = parseQuantity(currentQuantity, 'Current quantity');

  if (request.kind === 'adjustment') {
    if (request.countedQuantity === undefined) {
      throw new RangeError('An adjustment needs the quantity you counted');
    }
    const counted = parseQuantity(request.countedQuantity, 'Counted quantity');
    if (counted < 0) {
      throw new RangeError('A counted quantity cannot be negative');
    }
    const delta = (hundredths(counted) - hundredths(current)) / 100;
    if (delta === 0) {
      throw new RangeError('That count matches the current quantity — nothing to record');
    }
    return round2(delta);
  }

  if (request.amount === undefined) {
    throw new RangeError('A quantity is required');
  }
  const amount = parseQuantity(request.amount, 'Quantity');
  if (amount <= 0) {
    throw new RangeError('Enter a quantity greater than zero');
  }
  return round2(amount * DIRECTION[request.kind]);
}

/**
 * The running total after applying `delta`.
 *
 * Refuses to go below zero. A clinic cannot hold minus three boxes of gloves,
 * and the useful moment to say so is when someone records using more than the
 * system thinks is there — that is the signal that a receipt was never
 * entered, and it is worth interrupting for.
 */
export function nextQuantity(currentQuantity: number, delta: number): number {
  const current = hundredths(parseQuantity(currentQuantity, 'Current quantity'));
  const change = hundredths(parseQuantity(delta, 'Change'));
  const next = current + change;

  if (next < 0) {
    throw new RangeError(
      `That would leave ${(next / 100).toFixed(2)} in stock. ` +
        `There ${current === 100 ? 'is' : 'are'} ${(current / 100).toFixed(2)} on record — ` +
        'record the stock you received first, or use a stock count instead.',
    );
  }
  if (next / 100 > MAX_QUANTITY) {
    throw new RangeError('That is more stock than this system can store');
  }
  return next / 100;
}

/** At or below the reorder level, and still in use. */
export function isLowStock(item: {
  quantity: number;
  minimumQuantity: number;
  status: string;
}): boolean {
  if (item.status !== 'active') return false;
  return hundredths(item.quantity) <= hundredths(item.minimumQuantity);
}

/**
 * Out entirely. Distinguished from low because the two want different words
 * in front of a person: "order more" versus "you have none".
 */
export function isOutOfStock(item: { quantity: number; status: string }): boolean {
  return item.status === 'active' && hundredths(item.quantity) === 0;
}
