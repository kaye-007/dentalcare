/* eslint-disable @typescript-eslint/no-var-requires */
const { assertNotProduction } = require('./seed.js') as {
  assertNotProduction: (connectionString: string) => void;
};

/**
 * Regression tests for the seed guard.
 *
 * seed.js upserts credentials published in the README (admin@nodex.al /
 * Admin123!) with ON CONFLICT ... DO UPDATE SET password_hash. Run once
 * against production it would overwrite the live superadmin password with a
 * public default and report success. The guard is the control that keeps it
 * away from anything that is not obviously local.
 */
const LOCAL = 'postgres://dentalcare:dentalcare@localhost:5432/dentalcare';

describe('seed guard', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.ALLOW_REMOTE_SEED;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('allows a local database', () => {
    expect(() => assertNotProduction(LOCAL)).not.toThrow();
  });

  it.each(['localhost', '127.0.0.1', 'postgres', 'host.docker.internal'])(
    'allows the local host %s',
    (host) => {
      expect(() =>
        assertNotProduction(`postgres://u:p@${host}:5432/dentalcare`),
      ).not.toThrow();
    },
  );

  it('refuses when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertNotProduction(LOCAL)).toThrow(/NODE_ENV=production/);
  });

  it('refuses a remote host by default', () => {
    expect(() =>
      assertNotProduction('postgres://u:p@db.example.com:5432/dentalcare'),
    ).toThrow(/non-local database/);
  });

  it('allows a remote host only with the explicit override', () => {
    process.env.ALLOW_REMOTE_SEED = 'yes';
    expect(() =>
      assertNotProduction('postgres://u:p@db.example.com:5432/dentalcare'),
    ).not.toThrow();
  });

  it('refuses a production-looking database name even on localhost', () => {
    expect(() =>
      assertNotProduction('postgres://u:p@localhost:5432/dentalcare_prod'),
    ).toThrow(/looks like production/);
  });

  it('refuses a production-looking host even with the remote override', () => {
    process.env.ALLOW_REMOTE_SEED = 'yes';
    expect(() =>
      assertNotProduction('postgres://u:p@prod-db.example.com:5432/dentalcare'),
    ).toThrow(/looks like production/);
  });

  it('rejects a malformed connection string', () => {
    expect(() => assertNotProduction('not-a-url')).toThrow(/valid connection string/);
  });
});
