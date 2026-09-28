/**
 * Which database the integration suite may write to.
 *
 * The suite creates clinics, staff, patients, invoices and appointments, and
 * deletes only what it created. Pointed at a developer's own database it
 * leaves test clinics behind in it; pointed at anything real it is worse.
 * It used to read the repository .env, whose DATABASE_URL is the database
 * the local API runs on, so `npm run test:integration` with nothing exported
 * ran against that.
 *
 * The rule now, decided before a single query:
 *
 *   1. TEST_DATABASE_URL and TEST_APP_DATABASE_URL name the suite's own
 *      database, from the environment or from .env. This is the way.
 *   2. DATABASE_URL and APP_DATABASE_URL exported for the run are accepted
 *      when CI is set (the CI job's throwaway service container), or when
 *      the database name says it is for tests (dentalcare_test, *_itest…).
 *   3. Anything else is refused, the .env DATABASE_URL above all.
 *
 * Never production: NODE_ENV=production, or "prod" in a host or name.
 * Both URLs must name the same database, since the suite sets up as the
 * owner and asserts as app_user, and two databases would prove nothing.
 */

/** A database whose name says it exists for tests. */
const DISPOSABLE = /(^|[_-])(test|tests|itest|ci|scratch)([_-]|$)/i;

function target(url, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid connection string.`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (/prod/i.test(host) || /prod/i.test(dbName)) {
    throw new Error(
      `Refusing to run the integration suite: ${label} ("${host}/${dbName}") looks like production.`,
    );
  }
  return { host, port: parsed.port || '5432', dbName };
}

function sameDatabase(a, b) {
  return a.host === b.host && a.port === b.port && a.dbName === b.dbName;
}

const HOW =
  '  Point the suite at a database of its own, for example in .env:\n' +
  '    TEST_DATABASE_URL=postgres://dentalcare:dentalcare@localhost:5432/dentalcare_test\n' +
  '    TEST_APP_DATABASE_URL=postgres://app_user:app_user_dev_pw@localhost:5432/dentalcare_test\n' +
  '  create it once (createdb dentalcare_test), and run the migrations against it.';

/**
 * @param {Record<string, string | undefined>} env    the environment as it was
 *        before .env was read: only what was exported for this run
 * @param {Record<string, string | undefined>} dotenv what .env contains
 * @returns {{ databaseUrl: string, appDatabaseUrl: string, source: string }}
 */
function resolveTestDatabase(env, dotenv = {}) {
  const pick = (key) => env[key] ?? dotenv[key];

  if (pick('NODE_ENV') === 'production') {
    throw new Error('Refusing to run the integration suite: NODE_ENV=production.');
  }

  const testUrl = pick('TEST_DATABASE_URL');
  const testAppUrl = pick('TEST_APP_DATABASE_URL');
  if (testUrl || testAppUrl) {
    if (!testUrl || !testAppUrl) {
      throw new Error(
        'Set both TEST_DATABASE_URL (the owner role) and TEST_APP_DATABASE_URL (app_user), or neither.',
      );
    }
    const owner = target(testUrl, 'TEST_DATABASE_URL');
    const app = target(testAppUrl, 'TEST_APP_DATABASE_URL');
    if (!sameDatabase(owner, app)) {
      throw new Error(
        'TEST_DATABASE_URL and TEST_APP_DATABASE_URL must name the same database.',
      );
    }
    return {
      databaseUrl: testUrl,
      appDatabaseUrl: testAppUrl,
      source: 'TEST_DATABASE_URL',
    };
  }

  if (env.DATABASE_URL && env.APP_DATABASE_URL) {
    const owner = target(env.DATABASE_URL, 'DATABASE_URL');
    const app = target(env.APP_DATABASE_URL, 'APP_DATABASE_URL');
    if (!sameDatabase(owner, app)) {
      throw new Error('DATABASE_URL and APP_DATABASE_URL must name the same database.');
    }
    if (env.CI || DISPOSABLE.test(owner.dbName)) {
      return {
        databaseUrl: env.DATABASE_URL,
        appDatabaseUrl: env.APP_DATABASE_URL,
        source: env.CI ? 'CI' : 'environment',
      };
    }
    throw new Error(
      `Refusing to run the integration suite against "${owner.dbName}": nothing says it is a test database.\n` +
        HOW,
    );
  }

  throw new Error(
    'Refusing to run the integration suite: no test database is named.\n' +
      '  The DATABASE_URL in .env is your development database, and the suite writes to\n' +
      '  whatever it runs against.\n' +
      HOW,
  );
}

module.exports = { resolveTestDatabase, DISPOSABLE };
