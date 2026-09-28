/**
 * The appointment lifecycle, as an explicit state machine.
 *
 * Kept as pure data and pure functions with no Nest or database dependency, so
 * the rules can be unit-tested exhaustively and read in one screen. The service
 * consults this; it never re-implements any part of it.
 *
 *        ┌─────────────┐
 *        │  scheduled  │──────────────┐
 *        └──────┬──────┘              │
 *               │ patient arrives     │ cancel / no-show
 *               │ (undo: back)        │
 *        ┌──────▼──────┐              │
 *        │  checked_in │──────────────┤
 *        └──────┬──────┘              │
 *               │ treatment starts    │
 *        ┌──────▼──────┐              │
 *        │ in_progress │──────────────┤ cancel only
 *        └──────┬──────┘              │
 *               │                     │
 *        ┌──────▼──────┐       ┌──────▼──────────────┐
 *        │  completed  │       │ cancelled / no_show │
 *        └─────────────┘       └──────────┬──────────┘
 *          (terminal)                     │ reinstate
 *                                         └──────► scheduled
 *
 * Two rules carry real weight:
 *
 *  - `completed` is terminal. Phase 5 bills from completed appointments, so
 *    silently reopening one would mean invoicing work that no longer reads as
 *    done. Correcting a wrongly-completed appointment is a deliberate act, not
 *    a click.
 *  - `no_show` is unreachable once treatment has started. A patient who is
 *    mid-procedure demonstrably turned up.
 *
 * A check-in can be taken back to `scheduled`. Nothing has happened to the
 * patient yet, and the desk that checked in the wrong Kola from a list of
 * namesakes needs one tap to put it right, not a cancellation.
 */

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Statuses that occupy a dentist, a chair and the patient's time. These are
 * the states the database EXCLUDE constraints treat as conflicting — the
 * literal list here must match the one in migration 0014.
 */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = [
  'scheduled',
  'checked_in',
  'in_progress',
];

export function isBlocking(status: AppointmentStatus): boolean {
  return BLOCKING_STATUSES.includes(status);
}

/** Legal destinations from each state. Empty array means terminal. */
const TRANSITIONS: Readonly<Record<AppointmentStatus, readonly AppointmentStatus[]>> =
  Object.freeze({
    scheduled: ['checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'],
    // Back to scheduled undoes a mistaken check-in; nothing was done yet.
    checked_in: ['in_progress', 'completed', 'cancelled', 'no_show', 'scheduled'],
    // Treatment has begun: it can only finish or be abandoned.
    in_progress: ['completed', 'cancelled'],
    // Terminal. Billing depends on this being stable.
    completed: [],
    // Reinstating a mistake is legitimate and re-checks every conflict.
    cancelled: ['scheduled'],
    no_show: ['scheduled'],
  });

export function allowedTransitions(from: AppointmentStatus): readonly AppointmentStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  return allowedTransitions(from).includes(to);
}

export function isStatus(value: unknown): value is AppointmentStatus {
  return (
    typeof value === 'string' &&
    (APPOINTMENT_STATUSES as readonly string[]).includes(value)
  );
}

export const STATUS_LABELS: Readonly<Record<AppointmentStatus, string>> =
  Object.freeze({
    scheduled: 'Scheduled',
    checked_in: 'Checked in',
    in_progress: 'In progress',
    completed: 'Completed',
    cancelled: 'Cancelled',
    no_show: 'No-show',
  });

/**
 * Why a particular move is refused, phrased for the person at the front desk
 * rather than for a log file.
 */
export function explainRefusal(
  from: AppointmentStatus,
  to: AppointmentStatus,
): string {
  if (from === to) {
    return `This appointment is already ${STATUS_LABELS[to].toLowerCase()}.`;
  }
  if (from === 'completed') {
    return 'A completed appointment cannot be changed. Create a new appointment instead.';
  }
  if (to === 'no_show' && from === 'in_progress') {
    return 'Treatment is already in progress, so this patient cannot be marked as a no-show.';
  }
  if (from === 'cancelled' || from === 'no_show') {
    return `A ${STATUS_LABELS[from].toLowerCase()} appointment can only be reinstated to Scheduled.`;
  }
  const options = allowedTransitions(from);
  return options.length
    ? `Cannot go from ${STATUS_LABELS[from]} to ${STATUS_LABELS[to]}. Allowed: ${options
        .map((s) => STATUS_LABELS[s])
        .join(', ')}.`
    : `${STATUS_LABELS[from]} is a final state.`;
}

/**
 * The lifecycle timestamp column a transition stamps, if any.
 * `completed_at` and `cancelled_at` are additionally enforced by CHECK
 * constraints in migration 0014, so this and the schema agree by construction.
 */
export const TIMESTAMP_COLUMN: Readonly<
  Partial<Record<AppointmentStatus, string>>
> = Object.freeze({
  checked_in: 'checked_in_at',
  in_progress: 'in_progress_at',
  completed: 'completed_at',
  cancelled: 'cancelled_at',
});
