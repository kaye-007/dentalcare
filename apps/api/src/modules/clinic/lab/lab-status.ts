/**
 * The life of one piece of lab work, as data and pure functions.
 *
 *   preparing ──► sent ──► received ──► fitted
 *        │          │          │
 *        └──────────┴──────────┴──► cancelled ──► (back where it was)
 *
 *   preparing  the dentist has ordered it; the impression or scan is being
 *              readied
 *   sent       it is at the laboratory
 *   received   it is back at the clinic, waiting to be fitted
 *   fitted     it is in the patient's mouth — done
 *
 * Forward may skip a step: a crown that comes back before anyone marked it
 * sent is simply received, and the missing stamp is filled with the same
 * moment. Backward is one step only, because it exists to undo a tap. A
 * cancelled job can be reinstated, and returns to the step its stamps say it
 * reached.
 *
 * Fitted is final once it has settled. For ten minutes it can still go back
 * to received — the Undo on the screen, or "that was the other patient's
 * crown" noticed a minute later — and after that the work is in the patient
 * and the record says so for good.
 */

export const LAB_STATUSES = [
  'preparing',
  'sent',
  'received',
  'fitted',
  'cancelled',
] as const;
export type LabStatus = (typeof LAB_STATUSES)[number];

/** The forward order. Cancelled sits outside it. */
const ORDER: readonly LabStatus[] = ['preparing', 'sent', 'received', 'fitted'];

/** How long a Fitted can still be taken back. */
export const FITTED_UNDO_MS = 10 * 60 * 1000;

export function isLabStatus(value: unknown): value is LabStatus {
  return typeof value === 'string' && (LAB_STATUSES as readonly string[]).includes(value);
}

export interface LabStamps {
  sentAt: Date | null;
  receivedAt: Date | null;
  fittedAt: Date | null;
}

/** Where a job stands by its stamps alone — what a reinstated job returns to. */
export function stageFromStamps(s: LabStamps): Exclude<LabStatus, 'cancelled'> {
  if (s.fittedAt) return 'fitted';
  if (s.receivedAt) return 'received';
  if (s.sentAt) return 'sent';
  return 'preparing';
}

/** The next step, as the one button a screen offers. */
export function nextStep(status: LabStatus): LabStatus | null {
  const i = ORDER.indexOf(status);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1]! : null;
}

/**
 * Why a move is refused, in words for the person who tried it; null if
 * allowed. `now` is the moment of the move, for the Fitted grace period.
 */
export function refusal(
  from: LabStatus,
  to: LabStatus,
  stamps: LabStamps,
  now: Date,
): string | null {
  if (from === to) return 'The lab work is already there.';
  if (from === 'fitted') {
    const fresh =
      stamps.fittedAt !== null &&
      now.getTime() - stamps.fittedAt.getTime() <= FITTED_UNDO_MS;
    return to === 'received' && fresh
      ? null
      : 'Fitted lab work is finished and cannot be changed.';
  }
  if (from === 'cancelled') {
    return to === stageFromStamps(stamps)
      ? null
      : 'Cancelled lab work can only be reinstated to where it was.';
  }
  if (to === 'cancelled') return null;
  const a = ORDER.indexOf(from);
  const b = ORDER.indexOf(to);
  if (b > a) return null;
  if (b === a - 1) return null;
  return 'Lab work moves back one step at a time.';
}

/**
 * The stamps after a move made at `now`: the step reached is stamped, any
 * earlier one that was skipped gets the same moment, and a step undone loses
 * its stamp.
 */
export function stampsAfter(to: LabStatus, current: LabStamps, now: Date): LabStamps {
  if (to === 'cancelled') return current;
  const reached = ORDER.indexOf(to);
  const keepOrNow = (step: number, value: Date | null) =>
    reached >= step ? (value ?? now) : null;
  return {
    sentAt: keepOrNow(1, current.sentAt),
    receivedAt: keepOrNow(2, current.receivedAt),
    fittedAt: keepOrNow(3, current.fittedAt),
  };
}
