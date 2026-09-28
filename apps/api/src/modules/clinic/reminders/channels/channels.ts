import { Injectable, Logger } from '@nestjs/common';
import type { MessagePurpose } from '@dentalcare/shared';

/**
 * Reminder delivery channels.
 *
 * Every reminder is delivered through a channel implementing this interface,
 * and the channel id is recorded on the reminder row. Two ship:
 *
 *   log   the internal channel. It sends nothing to the patient: the rendered
 *         message is recorded on the clinic's reminder row, under RLS, where
 *         staff can act on it. It is what a deployment with no SMS provider
 *         configured uses.
 *   sms   Twilio (twilio.ts), when SMS_PROVIDER=twilio and its credentials
 *         are set.
 *
 * registry.ts decides which is active. The scheduler, the manual trigger, the
 * log and the UI are the same for both.
 */
export interface ReminderPayload {
  /** E.164 for SMS, WhatsApp and Viber. The log channel ignores it. */
  to: string | null;
  message: string;
  /** Where the provider should report delivery, when receipts are enabled. */
  statusCallbackUrl: string | null;
  /**
   * The values the message was written from, for a channel that sends a
   * pre-approved template rather than free text (WhatsApp). Stored on the
   * reminder row, so a retry fills the template exactly as the first attempt.
   */
  templateValues?: TemplateValues | null;
}

/**
 * What a template-based channel is filled with. Rows written before 0012 carry
 * no purpose and are appointment reminders; the other values are present for
 * the kinds of message that use them (see MESSAGE_PLACEHOLDERS).
 */
export interface TemplateValues {
  locale: 'en' | 'sq';
  purpose?: MessagePurpose;
  first_name: string;
  clinic: string;
  date?: string;
  time?: string;
  dentist?: string;
  visit_date?: string;
  balance?: string;
  clinic_phone?: string;
}

export interface SendOutcome {
  /** The provider's id for the message — what a delivery receipt names. */
  providerMessageId: string | null;
  providerStatus: string | null;
}

export interface ReminderChannel {
  /** Stable id stored on the reminder row: 'log', 'sms', 'whatsapp_business', 'viber'. */
  readonly id: string;
  readonly label: string;
  /** 'internal' records; every other kind reaches the patient's phone. */
  readonly kind: 'internal' | 'sms' | 'whatsapp' | 'viber';
  send(payload: ReminderPayload): Promise<SendOutcome>;
  statusCallbackUrl?(tenantId: string, reminderId: string): string | null;
  /**
   * Whether this channel can carry a kind of message. Free-text channels
   * carry all of them; WhatsApp only those with an approved template.
   */
  supports?(purpose: MessagePurpose): boolean;
}

/**
 * Why a send did not go, in terms the retry policy can act on.
 *
 *   retryable  the provider definitely did not take the message and asked to
 *              be tried again later (busy, rate-limited)
 *   ambiguous  no answer, or an answer that does not say whether the message
 *              went. Never retried automatically: a patient receiving the same
 *              reminder twice is worse than a failure a person can see and
 *              resend
 *   optOut     the number has unsubscribed; stop reminding this patient
 *
 * Messages are written here, never copied from the provider: a provider's
 * error text can quote the phone number, and these reach the application log.
 */
export class DeliveryError extends Error {
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly optOut: boolean;
  readonly code: string | null;

  constructor(
    message: string,
    opts: {
      retryable?: boolean;
      ambiguous?: boolean;
      optOut?: boolean;
      code?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'DeliveryError';
    this.retryable = opts.retryable ?? false;
    this.ambiguous = opts.ambiguous ?? false;
    this.optOut = opts.optOut ?? false;
    this.code = opts.code ?? null;
  }
}

@Injectable()
export class LogChannel implements ReminderChannel {
  readonly id = 'log';
  readonly label = 'Internal log';
  readonly kind = 'internal' as const;
  private readonly logger = new Logger('ReminderLogChannel');

  async send(_payload: ReminderPayload): Promise<SendOutcome> {
    // Deliberately logs nothing about the patient.
    //
    // The rendered message names the patient and their clinic, and this ran
    // for every due reminder on every scan. The reminder row already holds the
    // message under RLS, which is the right place for it. The application log
    // is not, and on Cloudflare that log leaves the database's trust boundary
    // altogether.
    this.logger.log('reminder recorded on the internal log channel');
    return { providerMessageId: null, providerStatus: null };
  }
}
