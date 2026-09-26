import { validateEnv } from './env.validation';

/** SMS delivery configuration (0008). */

const base = {
  DATABASE_URL: 'postgres://owner@localhost/dentalcare',
  JWT_SECRET: 'a-development-secret-of-length',
};

const twilio = {
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'token-token-token-token',
  TWILIO_FROM: '+15005550006',
};

describe('SMS configuration', () => {
  it('sends nothing unless told to', () => {
    expect(validateEnv(base).SMS_PROVIDER).toBe('log');
  });

  it('refuses Twilio without its credentials', () => {
    expect(() => validateEnv({ ...base, SMS_PROVIDER: 'twilio' })).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() => validateEnv({ ...base, ...twilio, TWILIO_FROM: undefined })).toThrow(/TWILIO_FROM/);
  });

  it('accepts a number or a messaging service as the sender', () => {
    expect(validateEnv({ ...base, ...twilio }).SMS_PROVIDER).toBe('twilio');
    expect(() =>
      validateEnv({
        ...base,
        ...twilio,
        TWILIO_FROM: undefined,
        TWILIO_MESSAGING_SERVICE_SID: `MG${'0'.repeat(32)}`,
      }),
    ).not.toThrow();
  });

  it('refuses a sender that is not E.164', () => {
    expect(() => validateEnv({ ...base, ...twilio, TWILIO_FROM: '069 123 4567' })).toThrow(/E\.164/);
  });

  it('wants PUBLIC_API_URL as a bare origin, because receipts are signed against it', () => {
    expect(() =>
      validateEnv({ ...base, PUBLIC_API_URL: 'https://api.example.com/api' }),
    ).toThrow(/origin/);
    expect(() => validateEnv({ ...base, PUBLIC_API_URL: 'https://api.example.com' })).not.toThrow();
  });

  it('requires a receipt address for SMS in production', () => {
    const production = {
      ...base,
      ...twilio,
      NODE_ENV: 'production',
      JWT_SECRET: 'j'.repeat(40),
      PLATFORM_JWT_SECRET: 'p'.repeat(40),
      APP_DATABASE_URL: 'postgres://app_user@localhost/dentalcare',
      MFA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
    };
    expect(() => validateEnv(production)).toThrow(/PUBLIC_API_URL/);
    expect(() =>
      validateEnv({ ...production, PUBLIC_API_URL: 'https://api.example.com' }),
    ).not.toThrow();
  });
});

describe('WhatsApp content templates', () => {
  const sid = (n: number) => `HX${String(n).padStart(32, '0')}`;
  const whatsapp = (sids: string) => ({
    ...base,
    ...twilio,
    WHATSAPP_PROVIDER: 'twilio',
    TWILIO_WHATSAPP_FROM: '+355691234567',
    TWILIO_WHATSAPP_CONTENT_SIDS: sids,
  });

  it('accepts the bare-language form it shipped with', () => {
    expect(() => validateEnv(whatsapp(`en:${sid(1)},sq:${sid(2)}`))).not.toThrow();
  });

  it('accepts a template per kind of message (0012)', () => {
    expect(() => validateEnv(whatsapp(`sq:${sid(1)},followup.sq:${sid(2)},balance.en:${sid(3)}`))).not.toThrow();
  });

  it('refuses a kind of message that does not exist', () => {
    expect(() => validateEnv(whatsapp(`refund.sq:${sid(1)}`))).toThrow(/TWILIO_WHATSAPP_CONTENT_SIDS/);
  });
});
