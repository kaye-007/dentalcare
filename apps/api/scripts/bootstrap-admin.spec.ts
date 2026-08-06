/* eslint-disable @typescript-eslint/no-var-requires */
const { readInput } = require('./bootstrap-admin.js') as {
  readInput: () => { email: string; password: string; fullName: string };
};

/**
 * The seed scripts refuse to run in production by design, so this is the only
 * supported way to create a superadmin on a live database. Its validation is
 * therefore the last line of defence against a weak or published credential
 * reaching production.
 */
const STRONG = 'S7range-Quokka-Ledger-2026';

describe('bootstrap-admin input validation', () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env.PLATFORM_ADMIN_EMAIL;
    delete process.env.PLATFORM_ADMIN_PASSWORD;
    delete process.env.PLATFORM_ADMIN_NAME;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('accepts a valid email and strong password', () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@company.com';
    process.env.PLATFORM_ADMIN_PASSWORD = STRONG;
    expect(readInput()).toEqual({
      email: 'ops@company.com',
      password: STRONG,
      fullName: 'Platform Administrator',
    });
  });

  it('uses PLATFORM_ADMIN_NAME when supplied', () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@company.com';
    process.env.PLATFORM_ADMIN_PASSWORD = STRONG;
    process.env.PLATFORM_ADMIN_NAME = 'Jordan Reyes';
    expect(readInput().fullName).toBe('Jordan Reyes');
  });

  it('requires an email', () => {
    process.env.PLATFORM_ADMIN_PASSWORD = STRONG;
    expect(() => readInput()).toThrow(/EMAIL is required/);
  });

  it.each(['notanemail', 'no@domain', 'a b@c.com', '@nope.com'])(
    'rejects the malformed email %s',
    (email) => {
      process.env.PLATFORM_ADMIN_EMAIL = email;
      process.env.PLATFORM_ADMIN_PASSWORD = STRONG;
      expect(() => readInput()).toThrow(/not a valid email/);
    },
  );

  it('requires a password', () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@company.com';
    expect(() => readInput()).toThrow(/PASSWORD is required/);
  });

  it('rejects a password shorter than 12 characters', () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@company.com';
    process.env.PLATFORM_ADMIN_PASSWORD = 'short-one';
    expect(() => readInput()).toThrow(/at least 12 characters/);
  });

  // The important one: these are printed in the README and the demo docs.
  it.each(['Demo@2026!', 'Admin123!', 'Owner123!', 'password', 'changeme'])(
    'rejects the published credential %s with a specific reason',
    (password) => {
      process.env.PLATFORM_ADMIN_EMAIL = 'ops@company.com';
      process.env.PLATFORM_ADMIN_PASSWORD = password;
      expect(() => readInput()).toThrow(/published in this repository/);
    },
  );

  it('matches published credentials case-insensitively', () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@company.com';
    process.env.PLATFORM_ADMIN_PASSWORD = 'demo@2026!';
    expect(() => readInput()).toThrow(/published in this repository/);
  });

  it('trims surrounding whitespace from the email', () => {
    process.env.PLATFORM_ADMIN_EMAIL = '  ops@company.com  ';
    process.env.PLATFORM_ADMIN_PASSWORD = STRONG;
    expect(readInput().email).toBe('ops@company.com');
  });
});
