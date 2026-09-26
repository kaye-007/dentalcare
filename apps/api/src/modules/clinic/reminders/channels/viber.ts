import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryError, type ReminderChannel, type ReminderPayload, type SendOutcome } from './channels';

/**
 * Viber Business Messages through the Vonage Messages API, with fetch.
 *
 * Twilio does not carry Viber, so this is a second provider. Vonage was
 * chosen because one API also covers SMS and WhatsApp, which leaves a clinic
 * that outgrows Twilio a single place to move to.
 *
 * ── What is and is not known here ─────────────────────────────────────────
 *
 * A Viber "transaction" message is free text, so the clinic's own wording is
 * sent. Vonage reports delivery to a webhook configured on the Vonage
 * APPLICATION, not per message, and signs it with a JWT; that receiver is not
 * built yet. So a Viber reminder can be shown as accepted, never as delivered,
 * and a patient who does not use Viber is discovered only by that missing
 * receipt. Built to Vonage's documented API; not yet exercised against a live
 * account (see DEPLOYMENT.md).
 *
 * ── Configuration ─────────────────────────────────────────────────────────
 *
 *   VIBER_PROVIDER=vonage
 *   VONAGE_API_KEY, VONAGE_API_SECRET (a secret)
 *   VONAGE_VIBER_SENDER   the Viber service message id Vonage issued
 *   VONAGE_API_BASE_URL   defaults to https://api.nexmo.com
 */

/** What a failed Vonage response means for the reminder. Mirrors the Twilio policy. */
export function classifyVonageFailure(httpStatus: number, body: unknown): DeliveryError {
  const detail = body as { title?: unknown; type?: unknown } | null;
  const code = typeof detail?.type === 'string' ? detail.type.split('/').pop() ?? null : null;
  const ref = code ?? `HTTP ${httpStatus}`;
  if (httpStatus === 429 || httpStatus === 503) {
    return new DeliveryError(`The Viber provider is busy (${ref}); it will be tried again.`, {
      code,
      retryable: true,
    });
  }
  if (httpStatus >= 500) {
    return new DeliveryError(
      `The Viber provider failed (${ref}). Check its message log before sending again.`,
      { code, ambiguous: true },
    );
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return new DeliveryError('The Viber provider refused the account credentials.', { code });
  }
  if (httpStatus === 402) {
    return new DeliveryError('The Viber provider account is out of credit.', { code });
  }
  return new DeliveryError(`The Viber provider refused the message (${ref}).`, { code });
}

const TIMEOUT_MS = 10_000;

@Injectable()
export class VonageViberChannel implements ReminderChannel {
  readonly id = 'viber';
  readonly label = 'Viber (Vonage)';
  readonly kind = 'viber' as const;

  constructor(private readonly config: ConfigService) {}

  private value(key: string): string | undefined {
    const v = this.config.get<string>(key);
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  }

  configured(): boolean {
    return (
      this.value('VIBER_PROVIDER') === 'vonage' &&
      Boolean(this.value('VONAGE_API_KEY')) &&
      Boolean(this.value('VONAGE_API_SECRET')) &&
      Boolean(this.value('VONAGE_VIBER_SENDER'))
    );
  }

  async send(payload: ReminderPayload): Promise<SendOutcome> {
    const key = this.value('VONAGE_API_KEY');
    const secret = this.value('VONAGE_API_SECRET');
    const sender = this.value('VONAGE_VIBER_SENDER');
    if (!this.configured() || !key || !secret || !sender) {
      throw new DeliveryError('Viber is not configured for this deployment.');
    }
    if (!payload.to) throw new DeliveryError('There is no mobile number to send to.');

    const base = (this.value('VONAGE_API_BASE_URL') ?? 'https://api.nexmo.com').replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          message_type: 'text',
          channel: 'viber_service',
          to: payload.to.replace(/^\+/, ''),
          from: sender,
          text: payload.message,
          // A reminder that arrives after the appointment is noise.
          viber_service: { category: 'transaction', ttl: 43_200 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new DeliveryError(
        'No response from the Viber provider. Check its message log before sending again.',
        { ambiguous: true },
      );
    }

    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw classifyVonageFailure(res.status, body);
    const id = (body as { message_uuid?: unknown } | null)?.message_uuid;
    return { providerMessageId: typeof id === 'string' ? id : null, providerStatus: 'submitted' };
  }
}
