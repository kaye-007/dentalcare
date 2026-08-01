import { Injectable, Logger } from '@nestjs/common';

/**
 * Reminder delivery channel abstraction.
 *
 * Every reminder is delivered through a channel implementing this interface,
 * and the channel id is recorded on the reminder row. For the MVP exactly one
 * channel ships: the internal LOG channel. It does NOT send anything to the
 * patient — it records the rendered message in the tenant's reminder log and
 * the server log, and the UI says so explicitly.
 *
 * Connecting a real provider post-MVP means adding e.g. SmsChannel
 * (Twilio/Vonage) or EmailChannel (SES/Resend) implementing this same
 * interface and registering it below — the scheduler, the manual trigger, the
 * log, and the UI all stay unchanged.
 */
export interface ReminderPayload {
  /** Patient phone/email when available — null is fine for the log channel. */
  to: string | null;
  message: string;
}

export interface ReminderChannel {
  /** Stable id stored on the reminder row, e.g. 'log', 'sms', 'email'. */
  readonly id: string;
  readonly label: string;
  send(payload: ReminderPayload): Promise<void>;
}

@Injectable()
export class LogChannel implements ReminderChannel {
  readonly id = 'log';
  readonly label = 'Internal log';
  private readonly logger = new Logger('ReminderLogChannel');

  async send(payload: ReminderPayload): Promise<void> {
    // Recording happens on the reminder row itself; this is the delivery side.
    this.logger.log(`reminder delivered to internal log (to=${payload.to ?? 'n/a'}): ${payload.message}`);
  }
}

@Injectable()
export class ChannelRegistry {
  constructor(private readonly log: LogChannel) {}

  /** The active delivery channel for this deployment. */
  active(): ReminderChannel {
    return this.log;
  }
}
