import { Injectable } from '@nestjs/common';
import type { MessagePurpose } from '@dentalcare/shared';
import { LogChannel, type ReminderChannel } from './channels';
import { TwilioSmsChannel } from './twilio';
import { TwilioWhatsAppChannel } from './whatsapp';
import { VonageViberChannel } from './viber';

/**
 * Which channel delivers a reminder.
 *
 * A clinic picks a default (SMS, WhatsApp or Viber) and a patient may pick
 * their own. Whether a channel can be used at all is a property of the
 * deployment — which providers have credentials — so the choice falls back:
 * the one asked for, then SMS, then the internal log. The reminder row keeps
 * the id of the channel that actually queued it, and `byId` resolves that id
 * when the row is attempted, so a reminder queued for a channel that has
 * since lost its credentials fails with a reason rather than quietly landing
 * in the log as if it had been sent.
 */
@Injectable()
export class ChannelRegistry {
  constructor(
    private readonly log: LogChannel,
    private readonly twilio: TwilioSmsChannel,
    private readonly whatsapp: TwilioWhatsAppChannel,
    private readonly viber: VonageViberChannel,
  ) {}

  /** The deployment's default when nobody has asked for anything: SMS, or the log. */
  active(): ReminderChannel {
    return this.sms() ?? this.log;
  }

  sms(): TwilioSmsChannel | null {
    return this.twilio.configured() ? this.twilio : null;
  }

  /**
   * The channel for a patient: their choice, the clinic's, SMS, the log —
   * skipping any that cannot carry this kind of message, such as WhatsApp
   * without an approved template for it.
   */
  resolve(purpose: MessagePurpose, ...preferences: (string | null | undefined)[]): ReminderChannel {
    for (const id of preferences) {
      const channel = id ? this.byId(id) : null;
      if (channel && channel !== this.log && this.carries(channel, purpose)) return channel;
    }
    return this.active();
  }

  /** Free-text channels carry every kind of message; template channels only their own. */
  carries(channel: ReminderChannel, purpose: MessagePurpose): boolean {
    return channel.supports ? channel.supports(purpose) : true;
  }

  /** Which patient-facing channels this deployment can use right now. */
  available(): { sms: boolean; whatsapp_business: boolean; viber: boolean } {
    return {
      sms: this.twilio.configured(),
      whatsapp_business: this.whatsapp.configured(),
      viber: this.viber.configured(),
    };
  }

  byId(id: string): ReminderChannel | null {
    if (id === this.log.id) return this.log;
    if (id === this.twilio.id) return this.sms();
    if (id === this.whatsapp.id) return this.whatsapp.configured() ? this.whatsapp : null;
    if (id === this.viber.id) return this.viber.configured() ? this.viber : null;
    return null;
  }
}
