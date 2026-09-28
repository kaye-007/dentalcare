import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeliveryError,
  type ReminderChannel,
  type ReminderPayload,
  type SendOutcome,
} from './channels';
import { classifyTwilioFailure } from './twilio';
import {
  MESSAGE_PURPOSE_KEYS,
  MESSAGE_PURPOSES,
  whatsappVariables,
  type MessagePurpose,
} from '@dentalcare/shared';

/**
 * WhatsApp Business through Twilio's Messages API — the same account, the
 * same endpoint and the same signed delivery receipts as SMS.
 *
 * ── Why the clinic's wording is not used ──────────────────────────────────
 *
 * WhatsApp lets a business START a conversation only with a template Meta has
 * approved in advance. Every message this system sends is exactly that, so
 * this channel sends a Content template — one per kind of message and
 * language — and fills its variables in the order WHATSAPP_VARIABLES gives
 * (packages/shared/src/messages.ts):
 *
 *   reminder   {{1}} first name  {{2}} date     {{3}} time        {{4}} dentist  {{5}} clinic
 *   followup   {{1}} first name  {{2}} clinic   {{3}} visit date  {{4}} clinic phone
 *   balance    {{1}} first name  {{2}} balance  {{3}} clinic      {{4}} clinic phone
 *
 * Each template must be approved with exactly those variables. A kind with no
 * template configured is not offered over WhatsApp. The text recorded on the
 * row is the built-in wording rendered with the same values — close to, not
 * identical with, what WhatsApp displays.
 *
 * ── Configuration ─────────────────────────────────────────────────────────
 *
 *   WHATSAPP_PROVIDER=twilio
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (shared with SMS)
 *   TWILIO_WHATSAPP_FROM            the approved WhatsApp sender, E.164
 *   TWILIO_WHATSAPP_CONTENT_SIDS    "sq:HX…,en:HX…,followup.sq:HX…,balance.sq:HX…"
 *                                   a bare language is the appointment reminder
 */

/** WhatsApp error codes that mean this patient cannot be reached this way. */
const UNREACHABLE = new Set(['63003', '63024', '21211', '21614']);

/**
 * "sq:HX…,followup.sq:HX…" -> keys "reminder.sq", "followup.sq". A bare
 * language is the appointment reminder, which is how this was configured
 * before there were other kinds of message.
 */
export function parseContentSids(spec: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (spec ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [key, sid] = part.split(':').map((s) => s.trim());
    if (!key || !sid || !/^HX[0-9a-fA-F]{32}$/.test(sid)) continue;
    out.set(key.includes('.') ? key : `reminder.${key}`, sid);
  }
  return out;
}

/** The approved template for a kind of message: its language, then English, then any. */
export function contentSidFor(
  sids: Map<string, string>,
  purpose: MessagePurpose,
  locale: string,
): string | null {
  const kind = MESSAGE_PURPOSE_KEYS[purpose];
  const own = [...sids.entries()].filter(([k]) => k.startsWith(`${kind}.`));
  return sids.get(`${kind}.${locale}`) ?? sids.get(`${kind}.en`) ?? own[0]?.[1] ?? null;
}

/** The template variables, in the order the approved template names them. */
export function contentVariables(
  v: NonNullable<ReminderPayload['templateValues']>,
): string {
  const purpose = v.purpose ?? 'appointment_reminder';
  return JSON.stringify(
    whatsappVariables(purpose, v as unknown as Record<string, string>),
  );
}

const TIMEOUT_MS = 10_000;

@Injectable()
export class TwilioWhatsAppChannel implements ReminderChannel {
  readonly id = 'whatsapp_business';
  readonly label = 'WhatsApp (Twilio)';
  readonly kind = 'whatsapp' as const;

  constructor(private readonly config: ConfigService) {}

  private value(key: string): string | undefined {
    const v = this.config.get<string>(key);
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  }

  configured(): boolean {
    return (
      this.value('WHATSAPP_PROVIDER') === 'twilio' &&
      Boolean(this.value('TWILIO_ACCOUNT_SID')) &&
      Boolean(this.value('TWILIO_AUTH_TOKEN')) &&
      Boolean(this.value('TWILIO_WHATSAPP_FROM')) &&
      parseContentSids(this.value('TWILIO_WHATSAPP_CONTENT_SIDS')).size > 0
    );
  }

  supports(purpose: MessagePurpose): boolean {
    if (!this.configured()) return false;
    return (
      contentSidFor(
        parseContentSids(this.value('TWILIO_WHATSAPP_CONTENT_SIDS')),
        purpose,
        'en',
      ) !== null
    );
  }

  /** Which kinds of message have an approved template. */
  supportedPurposes(): MessagePurpose[] {
    return MESSAGE_PURPOSES.filter((p) => this.supports(p));
  }

  /** Receipts come back to the same signed endpoint SMS uses. */
  statusCallbackUrl(tenantId: string, reminderId: string): string | null {
    const raw = this.value('PUBLIC_API_URL');
    if (!raw) return null;
    const query = new URLSearchParams({ tenant: tenantId, reminder: reminderId });
    return `${new URL(raw).origin}/api/reminders/delivery/twilio?${query.toString()}`;
  }

  async send(payload: ReminderPayload): Promise<SendOutcome> {
    const sid = this.value('TWILIO_ACCOUNT_SID');
    const token = this.value('TWILIO_AUTH_TOKEN');
    const from = this.value('TWILIO_WHATSAPP_FROM');
    if (!this.configured() || !sid || !token || !from) {
      throw new DeliveryError('WhatsApp is not configured for this deployment.');
    }
    if (!payload.to) throw new DeliveryError('There is no mobile number to send to.');
    const values = payload.templateValues;
    if (!values) {
      throw new DeliveryError(
        'This reminder has no template values to send over WhatsApp.',
      );
    }
    const sids = parseContentSids(this.value('TWILIO_WHATSAPP_CONTENT_SIDS'));
    const contentSid = contentSidFor(
      sids,
      values.purpose ?? 'appointment_reminder',
      values.locale,
    );
    if (!contentSid) {
      throw new DeliveryError(
        'No approved WhatsApp template is configured for this kind of message.',
      );
    }

    const form = new URLSearchParams({
      To: `whatsapp:${payload.to}`,
      From: `whatsapp:${from}`,
      ContentSid: contentSid,
      ContentVariables: contentVariables(values),
    });
    if (payload.statusCallbackUrl) form.set('StatusCallback', payload.statusCallbackUrl);

    const base = (this.value('TWILIO_API_BASE_URL') ?? 'https://api.twilio.com').replace(
      /\/+$/,
      '',
    );
    let res: Response;
    try {
      res = await fetch(`${base}/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new DeliveryError(
        'No response from the WhatsApp provider. Check its message log before sending again.',
        { ambiguous: true },
      );
    }

    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const code = String((body as { code?: unknown } | null)?.code ?? '');
      if (UNREACHABLE.has(code)) {
        throw new DeliveryError('This number cannot receive WhatsApp messages.', {
          code,
        });
      }
      throw classifyTwilioFailure(res.status, body);
    }
    const out = (body ?? {}) as { sid?: unknown; status?: unknown };
    return {
      providerMessageId: typeof out.sid === 'string' ? out.sid : null,
      providerStatus: typeof out.status === 'string' ? out.status : null,
    };
  }
}
