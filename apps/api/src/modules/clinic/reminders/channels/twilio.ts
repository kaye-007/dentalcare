import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryError, type ReminderChannel, type ReminderPayload, type SendOutcome } from './channels';

/**
 * SMS through Twilio's REST API, with fetch — no SDK.
 *
 * The SDK is several megabytes of Node-only code for one POST, and this API
 * also runs as a Cloudflare Worker. `fetch`, URLSearchParams and node:crypto's
 * HMAC are available on both runtimes.
 *
 * ── Configuration ─────────────────────────────────────────────────────────
 *
 *   SMS_PROVIDER=twilio
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (a secret)
 *   TWILIO_FROM (an E.164 number) or TWILIO_MESSAGING_SERVICE_SID
 *   PUBLIC_API_URL  the API's public origin. Without it messages still send,
 *                   but no delivery receipts come back, so the log can say a
 *                   message was accepted and never that it arrived.
 *   TWILIO_API_BASE_URL  defaults to https://api.twilio.com; the integration
 *                   suite points it at a local stand-in.
 *
 * ── Receipts ──────────────────────────────────────────────────────────────
 *
 * Twilio calls StatusCallback with a form POST signed by X-Twilio-Signature:
 * HMAC-SHA1 over the full URL followed by every POST parameter, sorted by
 * name, name immediately followed by value, keyed with the auth token. The
 * callback URL names the clinic and the reminder, so the signature over the
 * URL is also what stops a caller from pointing a receipt at another clinic.
 */

/** Twilio's request signature for a form POST. */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(payload, 'utf-8')).digest('base64');
}

/** Constant-time comparison of a presented signature with the expected one. */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  presented: string,
): boolean {
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(presented);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * What a failed Twilio response means for the reminder.
 *
 * Only a response that says "not now" is retried. A 5xx other than 503 does
 * not say whether the message was queued, so it is left for a person.
 */
export function classifyTwilioFailure(httpStatus: number, body: unknown): DeliveryError {
  const raw = (body as { code?: unknown } | null)?.code;
  const code = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : null;
  const ref = code ?? `HTTP ${httpStatus}`;

  if (code === '21610') {
    return new DeliveryError(
      'The patient has unsubscribed from messages sent from this number (replied STOP).',
      { code, optOut: true },
    );
  }
  if (httpStatus === 429 || httpStatus === 503) {
    return new DeliveryError(`The SMS provider is busy (${ref}); it will be tried again.`, {
      code,
      retryable: true,
    });
  }
  if (httpStatus >= 500) {
    return new DeliveryError(
      `The SMS provider failed (${ref}). Check its message log before sending again.`,
      { code, ambiguous: true },
    );
  }
  if (code === '21211' || code === '21614') {
    return new DeliveryError('The number on file is not a valid mobile number.', { code });
  }
  if (httpStatus === 401 || httpStatus === 403 || code === '20003') {
    return new DeliveryError('The SMS provider refused the account credentials.', { code });
  }
  return new DeliveryError(`The SMS provider refused the message (${ref}).`, { code });
}

const TIMEOUT_MS = 10_000;

@Injectable()
export class TwilioSmsChannel implements ReminderChannel {
  readonly id = 'sms';
  readonly label = 'SMS (Twilio)';
  readonly kind = 'sms' as const;

  constructor(private readonly config: ConfigService) {}

  private value(key: string): string | undefined {
    const v = this.config.get<string>(key);
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  }

  configured(): boolean {
    return (
      this.value('SMS_PROVIDER') === 'twilio' &&
      Boolean(this.value('TWILIO_ACCOUNT_SID')) &&
      Boolean(this.value('TWILIO_AUTH_TOKEN')) &&
      Boolean(this.value('TWILIO_FROM') || this.value('TWILIO_MESSAGING_SERVICE_SID'))
    );
  }

  /** Whether delivery receipts can come back at all. */
  receiptsEnabled(): boolean {
    return this.configured() && this.origin() !== null;
  }

  statusCallbackUrl(tenantId: string, reminderId: string): string | null {
    const origin = this.origin();
    if (!origin) return null;
    const query = new URLSearchParams({ tenant: tenantId, reminder: reminderId });
    return `${origin}/api/reminders/delivery/twilio?${query.toString()}`;
  }

  /**
   * Check a receipt's signature. `originalUrl` is the path and query as the
   * request arrived; the origin is ours, from configuration, because behind a
   * proxy or a service binding the request's own Host is not what Twilio
   * signed.
   */
  verifyReceipt(
    originalUrl: string,
    params: Record<string, string>,
    signature: string | undefined,
  ): boolean {
    const origin = this.origin();
    const token = this.value('TWILIO_AUTH_TOKEN');
    if (!origin || !token || !signature) return false;
    return verifyTwilioSignature(token, `${origin}${originalUrl}`, params, signature);
  }

  async send(payload: ReminderPayload): Promise<SendOutcome> {
    const sid = this.value('TWILIO_ACCOUNT_SID');
    const token = this.value('TWILIO_AUTH_TOKEN');
    if (!this.configured() || !sid || !token) {
      throw new DeliveryError('SMS is not configured for this deployment.');
    }
    if (!payload.to) {
      throw new DeliveryError('There is no mobile number to send to.');
    }

    const form = new URLSearchParams({ To: payload.to, Body: payload.message });
    const service = this.value('TWILIO_MESSAGING_SERVICE_SID');
    if (service) form.set('MessagingServiceSid', service);
    else form.set('From', this.value('TWILIO_FROM')!);
    if (payload.statusCallbackUrl) form.set('StatusCallback', payload.statusCallbackUrl);

    const base = (this.value('TWILIO_API_BASE_URL') ?? 'https://api.twilio.com').replace(/\/+$/, '');
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
        'No response from the SMS provider. Check its message log before sending again.',
        { ambiguous: true },
      );
    }

    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw classifyTwilioFailure(res.status, body);

    const out = (body ?? {}) as { sid?: unknown; status?: unknown };
    return {
      providerMessageId: typeof out.sid === 'string' ? out.sid : null,
      providerStatus: typeof out.status === 'string' ? out.status : null,
    };
  }

  private origin(): string | null {
    const raw = this.value('PUBLIC_API_URL');
    if (!raw) return null;
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  }
}
