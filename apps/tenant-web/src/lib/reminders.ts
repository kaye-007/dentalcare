import type { Reminder } from './api';

/**
 * How a reminder's state reads to a person, in one place, so the reminder log
 * and the appointment panel cannot describe the same row differently.
 *
 * The distinction that matters most is between "Sent" and "Delivered". A
 * message the provider accepted may still never arrive; a WhatsApp or email
 * hand-off only means the staff member's own app was opened. Neither is
 * written as if the patient had the message.
 */

/** Channels a server-side provider delivers through, as opposed to a hand-off. */
const PROVIDER_CHANNELS = new Set(['sms', 'whatsapp_business', 'viber']);

export function channelLabel(channel: string): string {
  switch (channel) {
    case 'sms':
      return 'SMS';
    case 'whatsapp_business':
      return 'WhatsApp';
    case 'viber':
      return 'Viber';
    case 'whatsapp':
      return 'WhatsApp (by hand)';
    case 'email':
      return 'Email';
    default:
      return 'Internal log';
  }
}

export function reminderState(r: Pick<Reminder, 'status' | 'channel'>): {
  status: 'completed' | 'info' | 'no_show' | 'neutral' | 'scheduled';
  label: string;
} {
  switch (r.status) {
    case 'delivered':
      return { status: 'completed', label: 'Delivered' };
    case 'sent':
      if (PROVIDER_CHANNELS.has(r.channel)) return { status: 'info', label: 'Sent' };
      if (r.channel === 'log') return { status: 'completed', label: 'Recorded' };
      return { status: 'completed', label: 'Handed off' };
    case 'failed':
      return { status: 'no_show', label: 'Failed' };
    case 'skipped':
      return { status: 'neutral', label: 'Not sent' };
    case 'sending':
      return { status: 'scheduled', label: 'Sending' };
    default:
      return { status: 'scheduled', label: 'Queued' };
  }
}
