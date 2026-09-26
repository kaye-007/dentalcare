/**
 * Invoice arithmetic: discounts, VAT, and the apportionment that turns a
 * plan-level discount into concrete per-line amounts.
 *
 * Pure integer functions. Three rules hold everything together:
 *
 * 1. MONEY IS INTEGER MINOR UNITS — cents — consistent with every other
 *    money column in the product since migration 0006. No float ever touches
 *    a price. VAT is therefore rounded half-up to the cent, not the euro.
 *
 * 2. DISCOUNTS LIVE ON LINES. A whole-invoice discount cannot coexist with
 *    correct VAT — tax is charged on the discounted value of each taxable
 *    line, so a discount floating above the lines has no defined tax effect.
 *    A plan-level discount is therefore APPORTIONED down to the lines before
 *    an invoice exists, and what is stored is the concrete per-line figure.
 *
 * 3. THE APPORTIONED PARTS SUM EXACTLY TO THE WHOLE. Splitting 100 across
 *    three lines cannot yield 33 + 33 + 33; the lost unit has to land
 *    somewhere. `apportion` distributes remainders by largest fractional
 *    part, so the parts always total the original amount exactly.
 *
 * VAT rates are BASIS POINTS (1/100 of a percent): 20% is 2000. Percent as an
 * integer cannot express 8.5%, and as a float it reintroduces the rounding
 * this file exists to avoid.
 */

export const VAT_RATE_SCALE = 10_000;

/**
 * Split `amount` across `weights` so the parts sum to exactly `amount`.
 *
 * Largest-remainder method: floor every share, then hand the leftover units
 * one at a time to the lines with the largest discarded fraction. This is the
 * standard apportionment rule and it is stable — the same input always
 * produces the same split, so an invoice regenerated tomorrow matches the one
 * quoted today.
 */
export function apportion(amount: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];

  const whole = Math.max(0, Math.round(amount));
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);

  // Nothing to weigh by: spread as evenly as the integers allow.
  if (total <= 0) {
    const base = Math.floor(whole / n);
    const parts = new Array<number>(n).fill(base);
    for (let i = 0; i < whole - base * n; i++) parts[i]! += 1;
    return parts;
  }

  const exact = weights.map((w) => (Math.max(0, w) * whole) / total);
  const parts = exact.map((v) => Math.floor(v));
  let remainder = whole - parts.reduce((s, v) => s + v, 0);

  // Rank by discarded fraction, breaking ties by index so the result is
  // deterministic rather than dependent on sort stability.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; remainder > 0; k = (k + 1) % n) {
    parts[order[k]!.i] += 1;
    remainder -= 1;
  }
  return parts;
}

export interface InvoiceLineInput {
  quantity: number;
  unitPrice: number;
  /** Absolute discount on this line, minor units. */
  discountAmount: number;
  /** Basis points. 0 for an exempt service. */
  taxRateBp: number;
}

export interface InvoiceLineCost {
  /** unitPrice × quantity, before discount. */
  subtotal: number;
  discountAmount: number;
  /** Taxable base: subtotal − discount. */
  net: number;
  taxAmount: number;
  /** net + tax — what this line contributes to the invoice. */
  total: number;
}

/**
 * VAT is charged on the DISCOUNTED value of the line, which is what every VAT
 * regime the product is likely to meet requires. Rounding is half-up at the
 * line, matching the way an invoice is read down the page and totalled.
 */
export function calculateInvoiceLine(line: InvoiceLineInput): InvoiceLineCost {
  const qty = Math.max(1, Math.round(line.quantity));
  const unit = Math.max(0, Math.round(line.unitPrice));
  const subtotal = unit * qty;
  const discountAmount = Math.min(Math.max(0, Math.round(line.discountAmount)), subtotal);
  const net = subtotal - discountAmount;
  const rate = Math.min(VAT_RATE_SCALE, Math.max(0, Math.round(line.taxRateBp)));
  const taxAmount = Math.round((net * rate) / VAT_RATE_SCALE);
  return { subtotal, discountAmount, net, taxAmount, total: net + taxAmount };
}

export interface InvoiceCost {
  subtotal: number;
  discountAmount: number;
  net: number;
  taxAmount: number;
  total: number;
  lineCount: number;
  /** True when any line carries VAT — drives whether the UI shows a tax row. */
  hasTax: boolean;
}

export function calculateInvoice(lines: readonly InvoiceLineInput[]): InvoiceCost {
  let subtotal = 0;
  let discountAmount = 0;
  let net = 0;
  let taxAmount = 0;

  for (const line of lines) {
    const c = calculateInvoiceLine(line);
    subtotal += c.subtotal;
    discountAmount += c.discountAmount;
    net += c.net;
    taxAmount += c.taxAmount;
  }

  return {
    subtotal,
    discountAmount,
    net,
    taxAmount,
    total: net + taxAmount,
    lineCount: lines.length,
    hasTax: taxAmount > 0,
  };
}

/**
 * Turn treatment-plan lines into invoice lines, pushing the plan-level
 * discount down onto them.
 *
 * The plan discount is weighted by each line's post-line-discount value, so a
 * line that is already half price does not absorb a disproportionate share of
 * the remaining reduction.
 */
export interface PlanLineForInvoice {
  quantity: number;
  unitFee: number;
  discountAmount: number;
  taxRateBp: number;
}

export function planLinesToInvoiceLines(
  planLines: readonly PlanLineForInvoice[],
  planDiscountAmount: number,
): InvoiceLineInput[] {
  const base = planLines.map((l) => ({
    quantity: Math.max(1, Math.round(l.quantity)),
    unitPrice: Math.max(0, Math.round(l.unitFee)),
    discountAmount: Math.max(0, Math.round(l.discountAmount)),
    taxRateBp: Math.max(0, Math.round(l.taxRateBp)),
  }));

  const nets = base.map((l) =>
    Math.max(0, l.unitPrice * l.quantity - l.discountAmount),
  );
  const netTotal = nets.reduce((s, v) => s + v, 0);
  const planDiscount = Math.min(Math.max(0, Math.round(planDiscountAmount)), netTotal);
  if (planDiscount === 0) return base;

  const extra = apportion(planDiscount, nets);
  return base.map((l, i) => ({
    ...l,
    // Cap per line so a rounding artefact can never exceed the line itself.
    discountAmount: Math.min(l.discountAmount + extra[i]!, l.unitPrice * l.quantity),
  }));
}

/* ══════════════════════ balances and ledger ══════════════════════ */

export const LEDGER_ENTRY_TYPES = [
  'charge',      // an invoice was issued — the patient owes more
  'payment',     // money received
  'adjustment',  // a correction agreed with the patient
  'refund',      // money returned
  'write_off',   // the clinic gave up on collecting
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * Sign convention: POSITIVE increases what the patient owes, NEGATIVE reduces
 * it. A patient's balance is the plain sum of their entries, so "what is
 * outstanding" is one aggregate rather than a reconciliation.
 */
export const LEDGER_SIGN: Readonly<Record<LedgerEntryType, 1 | -1>> = Object.freeze({
  charge: 1,
  payment: -1,
  adjustment: 1,   // caller passes a negative amount to reduce a bill
  refund: 1,       // money back to the patient increases what they owe again
  write_off: -1,
});

export const LEDGER_LABELS: Readonly<Record<LedgerEntryType, string>> = Object.freeze({
  charge: 'Invoice issued',
  payment: 'Payment received',
  adjustment: 'Adjustment',
  refund: 'Refund',
  write_off: 'Written off',
});

/** Invoice status derived from what has been paid against it. */
export type InvoiceStatus = 'unpaid' | 'partially_paid' | 'paid' | 'cancelled';

export function deriveInvoiceStatus(
  total: number,
  paid: number,
  cancelled: boolean,
): InvoiceStatus {
  if (cancelled) return 'cancelled';
  // A zero-total invoice is settled the moment it exists — nothing is owed,
  // so it must not sit in the unpaid list waiting for a payment of nothing.
  // This has to precede the paid-nothing check, which would otherwise claim it.
  if (total <= 0) return 'paid';
  if (paid <= 0) return 'unpaid';
  if (paid >= total) return 'paid';
  return 'partially_paid';
}

/**
 * Accounts-receivable ageing buckets, in days since the invoice was issued.
 * Standard 30-day bands: anything past 90 is the part a clinic chases.
 */
export const AGEING_BUCKETS = [
  { key: 'current', label: '0–30 days', min: 0, max: 30 },
  { key: 'd31_60', label: '31–60 days', min: 31, max: 60 },
  { key: 'd61_90', label: '61–90 days', min: 61, max: 90 },
  { key: 'over_90', label: 'Over 90 days', min: 91, max: Infinity },
] as const;

export type AgeingBucketKey = (typeof AGEING_BUCKETS)[number]['key'];

export function bucketFor(daysOutstanding: number): AgeingBucketKey {
  const d = Math.max(0, Math.floor(daysOutstanding));
  for (const b of AGEING_BUCKETS) {
    if (d >= b.min && d <= b.max) return b.key;
  }
  return 'over_90';
}

/**
 * Collection rate: what proportion of billed value has been collected.
 * Returns null rather than 0 when nothing was billed — a clinic that invoiced
 * nothing has no collection rate, and showing 0% would read as a failure.
 */
export function collectionRate(billed: number, collected: number): number | null {
  if (billed <= 0) return null;
  return Math.round((collected / billed) * 1000) / 10;
}

/* ══════════════════════ currency ══════════════════════ */

/**
 * Currencies a clinic can be denominated in, one per clinic. Defined in
 * @dentalcare/shared beside the formatting and parsing that depend on it, and
 * enforced by the database since 0006; re-exported so this module's existing
 * importers keep working.
 */
export { CURRENCIES, isCurrency, type CurrencyCode } from '@dentalcare/shared';
