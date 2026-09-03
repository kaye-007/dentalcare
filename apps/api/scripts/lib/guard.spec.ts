/**
 * Tests for the production guard on the destructive data scripts.
 *
 * These were deleted in an earlier cleanup pass, which left the only control
 * standing between `seed-demo`, `reset-demo` and `migrate:reset` and a live
 * database completely unverified — while the security document recorded the
 * matching CRITICAL finding as "closed by removal" of scripts that are in fact
 * still here. Reinstated, because `migrate:reset` now depends on this function
 * to decide whether it may drop a schema.
 *
 * Jest's roots were widened to include `scripts/` so that this actually runs.
 */

// The guard is plain JS invoked by node scripts, so it is required rather than
// imported; there is no .d.ts and none is warranted for 40 lines.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertNotProduction, assertSchemaCurrent, LOCAL_HOSTS } = require('./guard') as {
  assertNotProduction: (
    url: string,
    opts?: { overrideVar?: string; action?: string },
  ) => { host: string; dbName: string };
  assertSchemaCurrent: (
    client: { query: (sql: string) => Promise<{ rows: { name: string }[] }> },
    migrationsDir?: string,
  ) => Promise<void>;
  LOCAL_HOSTS: string[];
};

const LOCAL = 'postgres://u:p@localhost:5432/dentalcare';

describe('assertNotProduction', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env };
    delete process.env.NODE_ENV;
    delete process.env.ALLOW_REMOTE_SEED;
    delete process.env.ALLOW_REMOTE_RESET;
  });
  afterAll(() => {
    process.env = env;
  });

  it('allows a plainly local database', () => {
    expect(assertNotProduction(LOCAL)).toEqual({
      host: 'localhost',
      dbName: 'dentalcare',
    });
  });

  it.each(LOCAL_HOSTS)('treats %s as local', (host) => {
    // IPv6 literals must be bracketed to be a valid URL at all; WHATWG then
    // reports the hostname WITH the brackets, which is what broke the "::1"
    // entry before guard.js started stripping them.
    const authority = host.includes(':') ? `[${host}]` : host;
    expect(() =>
      assertNotProduction(`postgres://u:p@${authority}:5432/dentalcare`),
    ).not.toThrow();
  });

  it('rejects an unbracketed IPv6 host as the invalid URL it is', () => {
    expect(() => assertNotProduction('postgres://u:p@::1:5432/dentalcare')).toThrow(
      /not a valid connection string/,
    );
  });

  it('refuses outright when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    // Even for localhost: a production process pointed at a local socket is
    // still a production process.
    expect(() => assertNotProduction(LOCAL)).toThrow(/NODE_ENV=production/);
  });

  it('refuses a database whose NAME looks like production', () => {
    expect(() =>
      assertNotProduction('postgres://u:p@localhost:5432/dentalcare_prod'),
    ).toThrow(/looks like production/);
  });

  it('refuses a HOST that looks like production', () => {
    expect(() =>
      assertNotProduction('postgres://u:p@db.prod.internal:5432/dentalcare'),
    ).toThrow(/looks like production/);
  });

  it('refuses any non-local host by default', () => {
    expect(() =>
      assertNotProduction('postgres://u:p@db.eu.example.com:5432/dentalcare'),
    ).toThrow(/non-local database/);
  });

  it('allows a non-local host only with the explicit override', () => {
    process.env.ALLOW_REMOTE_SEED = 'yes';
    expect(() =>
      assertNotProduction('postgres://u:p@db.eu.example.com:5432/dentalcare'),
    ).not.toThrow();
  });

  it('honours a caller-specific override variable', () => {
    const remote = 'postgres://u:p@db.eu.example.com:5432/dentalcare';
    const opts = { overrideVar: 'ALLOW_REMOTE_RESET', action: 'reset' };

    // The seed override must NOT unlock a reset — they are different blast radii.
    process.env.ALLOW_REMOTE_SEED = 'yes';
    expect(() => assertNotProduction(remote, opts)).toThrow(/ALLOW_REMOTE_RESET/);

    process.env.ALLOW_REMOTE_RESET = 'yes';
    expect(() => assertNotProduction(remote, opts)).not.toThrow();
  });

  it('names the action it is refusing', () => {
    expect(() =>
      assertNotProduction('postgres://u:p@db.example.com:5432/x', {
        action: 'reset',
      }),
    ).toThrow(/Refusing to reset/);
  });

  it('rejects an unparseable connection string rather than guessing', () => {
    expect(() => assertNotProduction('not-a-url')).toThrow(
      /not a valid connection string/,
    );
  });

  /**
   * A known and accepted limit, asserted so it is visible rather than
   * discovered. The guard reasons about the connection string, and a
   * production database reached through an SSH tunnel presents as
   * 127.0.0.1 with whatever name it happens to have. Nothing in a URL can
   * distinguish that from a local database.
   *
   * The mitigations that DO cover it are NODE_ENV and the naming check; the
   * remaining exposure is a tunnelled, neutrally-named production database
   * with NODE_ENV unset. Operators should keep "prod" in production database
   * names for exactly this reason.
   */
  it('cannot detect a production database tunnelled to localhost', () => {
    expect(() =>
      assertNotProduction('postgres://u:p@127.0.0.1:5433/dentalcare'),
    ).not.toThrow();
  });
});

/**
 * A stale database is the failure mode that wastes the most time, because it
 * surfaces as whichever column the first missing migration would have added.
 * "column \"position\" of relation \"users\" does not exist" is four steps
 * removed from "your database stopped at 0010".
 */
describe('assertSchemaCurrent', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');

  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
    for (const name of ['0001_init.js', '0002_users.js', '0003_isolation.js']) {
      fs.writeFileSync(path.join(dir, name), '');
    }
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a migration');
  });

  const clientWith = (names: string[]) => ({
    query: async () => ({ rows: names.map((name) => ({ name })) }),
  });

  it('passes when every migration on disk has been applied', async () => {
    await expect(
      assertSchemaCurrent(clientWith(['0001_init', '0002_users', '0003_isolation']), dir),
    ).resolves.toBeUndefined();
  });

  it('names the first missing migration and the count', async () => {
    await expect(
      assertSchemaCurrent(clientWith(['0001_init']), dir),
    ).rejects.toThrow(/2 migration\(s\) behind[\s\S]*0002_users/);
  });

  it('tells you to run dev:setup when the database has no schema at all', async () => {
    const empty = {
      query: async () => {
        throw new Error('relation "pgmigrations" does not exist');
      },
    };
    await expect(assertSchemaCurrent(empty, dir)).rejects.toThrow(/never been migrated/);
  });

  it('ignores files in the migrations directory that are not migrations', async () => {
    await expect(
      assertSchemaCurrent(clientWith(['0001_init', '0002_users', '0003_isolation']), dir),
    ).resolves.toBeUndefined();
  });
});
