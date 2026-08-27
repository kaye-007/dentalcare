/**
 * Treatment plan cost calculation.
 *
 * Pure functions over integers. Two decisions shape this file:
 *
 * 1. MONEY IS INTEGER, whole currency units, matching invoices, treatments and
 *    expenses. No floats touch a price at any point — a plan total that
 *    disagrees with the invoice raised from it by one cent is a support call
 *    and a loss of trust, and floating point makes that inevitable eventually.
 *
 * 2. THERE IS NO INSURANCE LAYER. This build targets the Albanian market,
 *    where the patient pays the clinic directly. Modelling coverage we cannot
 *    validate against a real policy would produce confident numbers that are
 *    wrong. The chain is fee → line discount → plan discount → total, and
 *    every step is visible to the patient being quoted.
 *
 * Discounts are absolute amounts rather than percentages, for the same reason:
 * a percentage has to be rounded somewhere, and whoever rounds it owns the
 * discrepancy. A clinic that thinks in percentages computes the amount once,
 * in the UI, and the stored figure is what everyone agreed to.
 */

export interface PlanLineInput {
  /** Fee for one unit, whole currency units. */
  unitFee: number;
  quantity: number;
  /** Absolute discount on this line, whole currency units. */
  discountAmount: number;
  status: 'planned' | 'scheduled' | 'completed' | 'cancelled';
}

export interface PlanLineCost {
  /** unitFee × quantity, before any discount. */
  subtotal: number;
  discountAmount: number;
  /** What the patient pays for this line. */
  total: number;
}

export interface PlanCost {
  /** Sum of line subtotals, excluding cancelled lines. */
  subtotal: number;
  /** Sum of per-line discounts. */
  lineDiscounts: number;
  /** Plan-wide discount, after line discounts. */
  planDiscount: number;
  /** Every discount combined. */
  totalDiscount: number;
  /** What the patient pays in total. */
  total: number;
  /** Already delivered — the part that is invoiceable now. */
  completedTotal: number;
  /** Still to be done. */
  remainingTotal: number;
  lineCount: number;
  completedLineCount: number;
  cancelledLineCount: number;
}

/**
 * Cancelled lines contribute nothing. They stay on the plan as a record of
 * what was considered and dropped, which a patient may later ask about.
 */
function countsTowardTotal(line: PlanLineInput): boolean {
  return line.status !== 'cancelled';
}

export function calculateLine(line: PlanLineInput): PlanLineCost {
  const subtotal = Math.max(0, Math.round(line.unitFee)) * Math.max(1, Math.round(line.quantity));
  // Never let a line go negative: a discount larger than the line is a data
  // error, and the database CHECK rejects it, but a read path must not produce
  // a negative quote if a row predates that constraint.
  const discountAmount = Math.min(Math.max(0, Math.round(line.discountAmount)), subtotal);
  return { subtotal, discountAmount, total: subtotal - discountAmount };
}

export function calculatePlan(
  lines: readonly PlanLineInput[],
  planDiscountAmount = 0,
): PlanCost {
  const active = lines.filter(countsTowardTotal);

  let subtotal = 0;
  let lineDiscounts = 0;
  let completedTotal = 0;

  for (const line of active) {
    const cost = calculateLine(line);
    subtotal += cost.subtotal;
    lineDiscounts += cost.discountAmount;
    if (line.status === 'completed') completedTotal += cost.total;
  }

  const afterLineDiscounts = subtotal - lineDiscounts;
  // A plan discount can never exceed what remains after line discounts.
  const planDiscount = Math.min(
    Math.max(0, Math.round(planDiscountAmount)),
    afterLineDiscounts,
  );
  const total = afterLineDiscounts - planDiscount;

  return {
    subtotal,
    lineDiscounts,
    planDiscount,
    totalDiscount: lineDiscounts + planDiscount,
    total,
    // The plan-wide discount is deliberately NOT apportioned across completed
    // lines: it is agreed on the plan as a whole, and splitting it would
    // invent a per-line figure nobody consented to.
    completedTotal: Math.min(completedTotal, total),
    remainingTotal: Math.max(0, total - Math.min(completedTotal, total)),
    lineCount: lines.length,
    completedLineCount: lines.filter((l) => l.status === 'completed').length,
    cancelledLineCount: lines.filter((l) => l.status === 'cancelled').length,
  };
}

/**
 * Plan lifecycle. Mirrors the appointment machine's shape, for the same
 * reason: a status that can move anywhere is a status nobody can trust.
 */
export const PLAN_STATUSES = [
  'draft', 'proposed', 'accepted', 'in_progress', 'completed', 'declined',
] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

const PLAN_TRANSITIONS: Readonly<Record<PlanStatus, readonly PlanStatus[]>> =
  Object.freeze({
    // Still being written; can be shown to the patient or abandoned.
    draft: ['proposed', 'declined'],
    // Presented and awaiting an answer.
    proposed: ['accepted', 'declined', 'draft'],
    // Agreed; work can start.
    accepted: ['in_progress', 'completed', 'declined'],
    in_progress: ['completed', 'declined'],
    // Terminal: the plan was delivered.
    completed: [],
    // A declined plan can be revived as a draft if the patient reconsiders.
    declined: ['draft'],
  });

export function allowedPlanTransitions(from: PlanStatus): readonly PlanStatus[] {
  return PLAN_TRANSITIONS[from] ?? [];
}

export function canTransitionPlan(from: PlanStatus, to: PlanStatus): boolean {
  return allowedPlanTransitions(from).includes(to);
}

export function isPlanStatus(v: unknown): v is PlanStatus {
  return typeof v === 'string' && (PLAN_STATUSES as readonly string[]).includes(v);
}

export const PLAN_STATUS_LABELS: Readonly<Record<PlanStatus, string>> =
  Object.freeze({
    draft: 'Draft',
    proposed: 'Proposed',
    accepted: 'Accepted',
    in_progress: 'In progress',
    completed: 'Completed',
    declined: 'Declined',
  });

export function explainPlanRefusal(from: PlanStatus, to: PlanStatus): string {
  if (from === to) {
    return `This plan is already ${PLAN_STATUS_LABELS[to].toLowerCase()}.`;
  }
  if (from === 'completed') {
    return 'A completed plan cannot be reopened. Create a new plan instead.';
  }
  const options = allowedPlanTransitions(from);
  return options.length
    ? `Cannot go from ${PLAN_STATUS_LABELS[from]} to ${PLAN_STATUS_LABELS[to]}. Allowed: ${options
        .map((s) => PLAN_STATUS_LABELS[s])
        .join(', ')}.`
    : `${PLAN_STATUS_LABELS[from]} is a final state.`;
}

/** Timestamp column stamped when a plan enters each state. */
export const PLAN_TIMESTAMP_COLUMN: Readonly<Partial<Record<PlanStatus, string>>> =
  Object.freeze({
    proposed: 'proposed_at',
    accepted: 'accepted_at',
    declined: 'declined_at',
    completed: 'completed_at',
  });
