/**
 * The rules a reminder's status follows, with no database in them.
 */

export type ReminderStatus = 'pending' | 'sending' | 'sent' | 'delivered' | 'failed' | 'skipped';

/** First try plus two retries. */
export const MAX_ATTEMPTS = 3;

/** Minutes to wait after the Nth failed attempt, when the provider said "busy". */
const RETRY_DELAYS_MINUTES = [5, 30] as const;

/**
 * How long to wait before trying again, given how many attempts have now been
 * made — or null when that was the last one.
 */
export function retryDelayMinutes(attemptsMade: number): number | null {
  if (attemptsMade >= MAX_ATTEMPTS || attemptsMade < 1) return null;
  return RETRY_DELAYS_MINUTES[attemptsMade - 1] ?? null;
}

/**
 * A provider's message status as this system's. Unknown statuses change
 * nothing: a status Twilio adds next year must not be read as a failure.
 */
export function providerStatusToReminder(status: string): 'sent' | 'delivered' | 'failed' | null {
  switch (status.toLowerCase()) {
    case 'accepted':
    case 'scheduled':
    case 'queued':
    case 'sending':
    case 'sent':
      return 'sent';
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'undelivered':
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return null;
  }
}

const RANK: Readonly<Record<ReminderStatus, number>> = {
  skipped: -1,
  pending: 0,
  sending: 0,
  sent: 1,
  failed: 2,
  delivered: 3,
};

/**
 * Whether a receipt moves a reminder forward.
 *
 * Receipts arrive out of order — "sent" can land after "delivered" — so a
 * reminder only ever moves forward, and a reminder that was never sent is not
 * given a delivery status by a receipt that names it anyway.
 */
export function applyReceipt(current: ReminderStatus, next: 'sent' | 'delivered' | 'failed'): boolean {
  if (current === 'skipped') return false;
  return RANK[next] > RANK[current];
}
