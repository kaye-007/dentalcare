/**
 * How long an invoice issued offline has before it must reach the authority.
 *
 * The law allows an invoice to be handed to the patient with its NSLF and QR
 * while the connection is down, and delivered afterwards as a subsequent
 * delivery. That grace is 48 hours from the moment the invoice was issued —
 * not from the last attempt, and not from when anybody noticed.
 *
 * The arithmetic is here, apart from the service, because it decides what a
 * screen shouts about and what it leaves quiet, and because a rule with a
 * deadline in it should be a function somebody can read and test.
 */

export const DELIVERY_WINDOW_HOURS = 48;
/** When a pending registration stops being routine and starts being chased. */
export const ESCALATION_HOURS = [1, 12, 24, 40] as const;

export type QueueUrgency = 'routine' | 'watch' | 'urgent' | 'overdue';

export interface QueueTiming {
  /** Milliseconds since the invoice was issued. */
  ageMs: number;
  deliverBy: string;
  msLeft: number;
  overdue: boolean;
  urgency: QueueUrgency;
}

/**
 * Where one pending registration stands against the window.
 *
 *   routine   under an hour old: the retries are still working through it
 *   watch     over 12 hours: worth a look
 *   urgent    over 40 hours: someone has to act today
 *   overdue   past 48 hours: delivered late, and the clinic needs the record
 *             of why for its accountant
 */
export function queueTiming(issueDateTime: string, now: Date = new Date()): QueueTiming {
  const issuedAt = new Date(issueDateTime).getTime();
  const deadline = issuedAt + DELIVERY_WINDOW_HOURS * 3_600_000;
  const ageMs = now.getTime() - issuedAt;
  const msLeft = deadline - now.getTime();
  const hours = ageMs / 3_600_000;

  const urgency: QueueUrgency =
    msLeft <= 0
      ? 'overdue'
      : hours >= ESCALATION_HOURS[3]
        ? 'urgent'
        : hours >= ESCALATION_HOURS[1]
          ? 'watch'
          : 'routine';

  return {
    ageMs: Math.max(0, ageMs),
    deliverBy: new Date(deadline).toISOString(),
    msLeft,
    overdue: msLeft <= 0,
    urgency,
  };
}
