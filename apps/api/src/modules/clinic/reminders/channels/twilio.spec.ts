import type { ConfigService } from '@nestjs/config';
import { DeliveryError } from './channels';
import {
  TwilioSmsChannel,
  classifyTwilioFailure,
  twilioSignature,
  verifyTwilioSignature,
} from './twilio';

describe('Twilio request signatures', () => {
  /**
   * The worked example from Twilio's webhook security documentation
   * (twilio.com/docs/usage/security, "Validating signatures"). Matching it is
   * the only evidence available offline that receipts from the real service
   * will verify.
   */
  const token = '12345';
  const url = 'https://example.com/myapp.php?foo=1&bar=2';
  const params = {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+14158675310',
    Digits: '1234',
    From: '+14158675310',
    To: '+18005551212',
  };

  it('matches Twilio’s documented example', () => {
    expect(twilioSignature(token, url, params)).toBe('L/OH5YylLD5NRKLltdqwSvS0BnU=');
  });

  it('accepts the right signature and nothing else', () => {
    const good = twilioSignature(token, url, params);
    expect(verifyTwilioSignature(token, url, params, good)).toBe(true);
    expect(verifyTwilioSignature(token, url, { ...params, Digits: '9999' }, good)).toBe(false);
    expect(verifyTwilioSignature(token, `${url}&tenant=other`, params, good)).toBe(false);
    expect(verifyTwilioSignature('another-token', url, params, good)).toBe(false);
    expect(verifyTwilioSignature(token, url, params, '')).toBe(false);
  });
});

describe('classifyTwilioFailure', () => {
  it('stops reminding a number that unsubscribed', () => {
    const e = classifyTwilioFailure(400, { code: 21610, message: 'unsubscribed' });
    expect(e).toMatchObject({ optOut: true, retryable: false, code: '21610' });
  });

  it('retries only when the provider says "not now"', () => {
    expect(classifyTwilioFailure(429, { code: 20429 }).retryable).toBe(true);
    expect(classifyTwilioFailure(503, null).retryable).toBe(true);
    const unknown = classifyTwilioFailure(500, null);
    expect(unknown).toMatchObject({ retryable: false, ambiguous: true });
  });

  it('never repeats the provider’s own text, which can quote the number', () => {
    const e = classifyTwilioFailure(400, {
      code: 21211,
      message: "The 'To' number +355691234567 is not a valid phone number.",
    });
    expect(e.message).not.toContain('+355');
    expect(e.retryable).toBe(false);
  });
});

describe('TwilioSmsChannel', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const channel = (overrides: Record<string, string | undefined> = {}) => {
    const values: Record<string, string | undefined> = {
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
      TWILIO_AUTH_TOKEN: 'token-token-token',
      TWILIO_FROM: '+15005550006',
      TWILIO_API_BASE_URL: 'https://twilio.test',
      PUBLIC_API_URL: 'https://api.example.com',
      ...overrides,
    };
    return new TwilioSmsChannel({ get: (k: string) => values[k] } as unknown as ConfigService);
  };

  const respond = (status: number, body: unknown) =>
    jest.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it('is only configured with a sender and credentials', () => {
    expect(channel().configured()).toBe(true);
    expect(channel({ SMS_PROVIDER: 'log' }).configured()).toBe(false);
    expect(channel({ TWILIO_FROM: undefined }).configured()).toBe(false);
    expect(
      channel({ TWILIO_FROM: undefined, TWILIO_MESSAGING_SERVICE_SID: `MG${'b'.repeat(32)}` }).configured(),
    ).toBe(true);
  });

  it('posts the message and returns the provider’s id', async () => {
    const fetchMock = respond(201, { sid: 'SM123', status: 'queued' });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await channel().send({
      to: '+355691234567',
      message: 'Hi Ana',
      statusCallbackUrl: 'https://api.example.com/api/reminders/delivery/twilio?tenant=t&reminder=r',
    });

    expect(out).toEqual({ providerMessageId: 'SM123', providerStatus: 'queued' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://twilio.test/2010-04-01/Accounts/AC${'a'.repeat(32)}/Messages.json`);
    const form = new URLSearchParams(String(init.body));
    expect(form.get('To')).toBe('+355691234567');
    expect(form.get('From')).toBe('+15005550006');
    expect(form.get('StatusCallback')).toContain('/api/reminders/delivery/twilio');
  });

  it('uses a messaging service instead of a number when one is set', async () => {
    const fetchMock = respond(201, { sid: 'SM1' });
    global.fetch = fetchMock as unknown as typeof fetch;
    await channel({ TWILIO_MESSAGING_SERVICE_SID: `MG${'b'.repeat(32)}` }).send({
      to: '+355691234567',
      message: 'x',
      statusCallbackUrl: null,
    });
    const form = new URLSearchParams(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(form.get('MessagingServiceSid')).toBe(`MG${'b'.repeat(32)}`);
    expect(form.get('From')).toBeNull();
  });

  it('treats no response as ambiguous, never as retryable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('network')) as unknown as typeof fetch;
    await expect(
      channel().send({ to: '+355691234567', message: 'x', statusCallbackUrl: null }),
    ).rejects.toMatchObject({ ambiguous: true, retryable: false });
  });

  it('refuses to send without a number', async () => {
    await expect(
      channel().send({ to: null, message: 'x', statusCallbackUrl: null }),
    ).rejects.toBeInstanceOf(DeliveryError);
  });

  it('builds receipts on the configured origin only', () => {
    expect(channel().statusCallbackUrl('t1', 'r1')).toBe(
      'https://api.example.com/api/reminders/delivery/twilio?tenant=t1&reminder=r1',
    );
    expect(channel({ PUBLIC_API_URL: undefined }).statusCallbackUrl('t1', 'r1')).toBeNull();
    expect(channel({ PUBLIC_API_URL: undefined }).receiptsEnabled()).toBe(false);
  });
});
