/**
 * The integration suite writes to the database it runs against, so which one
 * it may use is decided here, before a query. See test-database.js.
 */

const { resolveTestDatabase } = require('./test-database') as {
  resolveTestDatabase: (
    env: Record<string, string | undefined>,
    dotenv?: Record<string, string | undefined>,
  ) => { databaseUrl: string; appDatabaseUrl: string; source: string };
};

const OWNER = (db: string, host = 'localhost') =>
  `postgres://dentalcare:pw@${host}:5432/${db}`;
const APP = (db: string, host = 'localhost') =>
  `postgres://app_user:pw@${host}:5432/${db}`;

/** What a developer's .env holds: the development database. */
const DEV_DOTENV = {
  DATABASE_URL: OWNER('dentalcare'),
  APP_DATABASE_URL: APP('dentalcare'),
};

describe('resolveTestDatabase', () => {
  it('refuses the development database that .env names', () => {
    expect(() => resolveTestDatabase({}, DEV_DOTENV)).toThrow(
      /no test database is named/,
    );
  });

  it('refuses when nothing names a database at all', () => {
    expect(() => resolveTestDatabase({}, {})).toThrow(/no test database is named/);
  });

  it('uses TEST_DATABASE_URL from .env over the development database', () => {
    const r = resolveTestDatabase(
      {},
      {
        ...DEV_DOTENV,
        TEST_DATABASE_URL: OWNER('dentalcare_test'),
        TEST_APP_DATABASE_URL: APP('dentalcare_test'),
      },
    );
    expect(r).toEqual({
      databaseUrl: OWNER('dentalcare_test'),
      appDatabaseUrl: APP('dentalcare_test'),
      source: 'TEST_DATABASE_URL',
    });
  });

  it('prefers an exported TEST_DATABASE_URL to the one in .env', () => {
    const r = resolveTestDatabase(
      {
        TEST_DATABASE_URL: OWNER('mine_itest'),
        TEST_APP_DATABASE_URL: APP('mine_itest'),
      },
      {
        TEST_DATABASE_URL: OWNER('other_test'),
        TEST_APP_DATABASE_URL: APP('other_test'),
      },
    );
    expect(r.databaseUrl).toBe(OWNER('mine_itest'));
  });

  it('needs both TEST_ URLs, not one', () => {
    expect(() => resolveTestDatabase({ TEST_DATABASE_URL: OWNER('x_test') })).toThrow(
      /both TEST_DATABASE_URL/,
    );
  });

  it('refuses TEST_ URLs that name two different databases', () => {
    expect(() =>
      resolveTestDatabase({
        TEST_DATABASE_URL: OWNER('a_test'),
        TEST_APP_DATABASE_URL: APP('b_test'),
      }),
    ).toThrow(/same database/);
  });

  it('accepts the URLs exported in CI', () => {
    const r = resolveTestDatabase({
      CI: 'true',
      DATABASE_URL: OWNER('dentalcare'),
      APP_DATABASE_URL: APP('dentalcare'),
    });
    expect(r.source).toBe('CI');
  });

  it.each(['dentalcare_test', 'dentalcare_itest', 'itest', 'ci-db', 'scratch_1'])(
    'accepts exported URLs for a database named %s',
    (db) => {
      expect(
        resolveTestDatabase({ DATABASE_URL: OWNER(db), APP_DATABASE_URL: APP(db) })
          .source,
      ).toBe('environment');
    },
  );

  it.each(['dentalcare', 'dentalcare_demo', 'clinic_data', 'latest', 'contest'])(
    'refuses exported URLs for a database named %s outside CI',
    (db) => {
      expect(() =>
        resolveTestDatabase({ DATABASE_URL: OWNER(db), APP_DATABASE_URL: APP(db) }),
      ).toThrow(/nothing says it is a test database/);
    },
  );

  it('refuses NODE_ENV=production even with test URLs', () => {
    expect(() =>
      resolveTestDatabase({
        NODE_ENV: 'production',
        TEST_DATABASE_URL: OWNER('x_test'),
        TEST_APP_DATABASE_URL: APP('x_test'),
      }),
    ).toThrow(/NODE_ENV=production/);
  });

  it('refuses a host or name that looks like production, even in CI', () => {
    expect(() =>
      resolveTestDatabase({
        CI: 'true',
        DATABASE_URL: OWNER('dentalcare', 'db.prod.example.com'),
        APP_DATABASE_URL: APP('dentalcare', 'db.prod.example.com'),
      }),
    ).toThrow(/looks like production/);
    expect(() =>
      resolveTestDatabase({
        TEST_DATABASE_URL: OWNER('dentalcare_prod_test'),
        TEST_APP_DATABASE_URL: APP('dentalcare_prod_test'),
      }),
    ).toThrow(/looks like production/);
  });
});
