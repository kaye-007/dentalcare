/**
 * What the `migrate` container does: bring an empty (or half-built) database
 * up to the schema on disk, optionally create the first platform
 * administrator, and exit 0. `docker compose up` gates the API on this
 * finishing, so the API can never start against an unmigrated database.
 *
 * It is written to be run again and again. Every step is a no-op when it has
 * already happened, because the normal case is `docker compose up` on a stack
 * that is already set up, and a startup step that fails the second time is a
 * startup step that gets removed.
 *
 * Not to be confused with scripts/dev-setup.js at the repo root. That one
 * owns the whole local machine — it creates the database, converges the role
 * password, and talks to the developer. This one runs inside a container
 * where compose has already created the database and the role convergence
 * happens in migration 0003, so it does the two things left.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { Client } = require('pg');

const API_DIR = path.resolve(__dirname, '..');

const G = '\x1b[32m',
  R = '\x1b[31m',
  D = '\x1b[2m',
  B = '\x1b[1m',
  X = '\x1b[0m';
const ok = (m) => console.log(`  ${G}ok${X}    ${m}`);
const info = (m) => console.log(`  ${D}..${X}    ${m}`);
const step = (m) => console.log(`\n${B}${m}${X}`);

function die(message) {
  console.error(`\n  ${R}FAILED${X}  ${message}\n`);
  process.exit(1);
}

/**
 * compose already gates this container on `pg_isready`, which reports the
 * server as accepting connections. That is one moment earlier than "will
 * accept MINE": on a first boot the entrypoint brings the server up, runs the
 * init scripts and restarts it, and a connection attempted in that window is
 * refused. Retrying for a minute costs nothing and removes a failure that
 * only ever appears on a cold machine.
 */
async function waitForPostgres(connectionString) {
  const deadline = Date.now() + 60_000;
  let lastError;
  for (let attempt = 1; ; attempt++) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return attempt;
    } catch (e) {
      lastError = e;
      await client.end().catch(() => undefined);
      if (Date.now() >= deadline) {
        die(`postgres did not accept a connection within 60s: ${lastError.message}`);
      }
      if (attempt === 1) info('waiting for postgres to accept connections');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Absolute path to the node-pg-migrate CLI.
 *
 * Not require.resolve(): the package's `exports` map does not publish bin/,
 * so Node rejects the subpath and — because the specifier already ends in
 * .js — reports it as a missing "node-pg-migrate.js.js".
 */
function nodePgMigrateBin() {
  const relative = path.join(
    'node_modules',
    'node-pg-migrate',
    'bin',
    'node-pg-migrate.js',
  );
  const roots = [path.resolve(__dirname, '..', '..', '..'), API_DIR];
  for (const root of roots) {
    const candidate = path.join(root, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  die(
    'node-pg-migrate is not installed in this image. It is a devDependency, ' +
      'so this container must be built from the `migrate` stage, not `runtime`.',
  );
}

/** Run a command in apps/api, inheriting stdio so its output is the log. */
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: API_DIR,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell: process.platform === 'win32',
  });
  if (result.error) die(`${command} could not be started: ${result.error.message}`);
  return result.status ?? 1;
}

/**
 * Does this database hold migrations that no longer exist on disk?
 *
 * That is the signature of a database created before the squash, and the only
 * case in which retrying with --no-check-order is the right answer. Anything
 * else that made `migrate up` fail is a real failure and stays one.
 */
async function looksPreSquash(connectionString) {
  const onDisk = new Set(
    fs
      .readdirSync(path.join(API_DIR, 'migrations'))
      .filter((f) => /^\d+_.+\.js$/.test(f))
      .map((f) => f.replace(/\.js$/, '')),
  );

  const client = new Client({ connectionString });
  try {
    await client.connect();
    const { rows } = await client.query('SELECT name FROM pgmigrations');
    return rows.some((r) => !onDisk.has(r.name));
  } catch {
    // No pgmigrations table at all means a fresh database, which cannot be
    // the pre-squash case.
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  console.log(`\n${B}DentalCare — container init${X}`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) die('DATABASE_URL is not set.');

  /* ── 1. postgres ─────────────────────────────────────────────────────── */
  step('1. postgres');
  const url = new URL(databaseUrl);
  const attempts = await waitForPostgres(databaseUrl);
  ok(
    `${url.hostname}:${url.port || 5432}/${url.pathname.slice(1)} reachable` +
      (attempts > 1 ? ` (after ${attempts} attempts)` : ''),
  );

  /* ── 2. migrations ───────────────────────────────────────────────────── */
  /* node-pg-migrate is a devDependency and is deliberately absent from the
     serving image — this container is built from the stage that has it. It
     reads DATABASE_URL from the environment; no --envPath, because the repo
     .env is excluded by .dockerignore and never reaches a container. */
  step('2. migrations');
  const migrate = (extra = []) =>
    run('node', [nodePgMigrateBin(), 'up', '-m', 'migrations', ...extra]);

  if (migrate() !== 0) {
    /* One specific failure is expected and recoverable: a database created
       before the migrations were squashed.

       0001_baseline sorts before 0001_init-extensions, which that database has
       already run, so node-pg-migrate refuses the whole batch — correctly, in
       general. Here it is exactly the situation a squash creates, and the
       baseline is built to handle it: it detects the existing schema, checks
       that ALL the superseded migrations were applied, and records itself
       without touching anything. A half-migrated database is still refused, by
       the baseline itself rather than by the ordering check.

       Retried rather than passed every time, because --no-check-order also
       silences the genuine version of this warning, and on a database that
       does not need it the first attempt simply succeeds. */
    if (!(await looksPreSquash(databaseUrl))) {
      die('migrations failed — the error is above.');
    }
    info('this database predates the migration squash — adopting the baseline');
    if (migrate(['--no-check-order']) !== 0) {
      die('migrations failed — the error is above.');
    }
  }
  ok('schema is up to date');

  /* ── 3. the first platform administrator ─────────────────────────────── */
  /* Optional, and opt-in by configuration rather than by a flag: a stack
     brought up without PLATFORM_ADMIN_EMAIL simply has no console account
     yet, which is the correct state for one where the account already exists
     or is created by hand. */
  step('3. platform administrator');
  const adminEmail = (process.env.PLATFORM_ADMIN_EMAIL || '').trim();
  if (!adminEmail) {
    info('PLATFORM_ADMIN_EMAIL not set — skipping');
    info('create one later with:  npm run admin:create');
  } else {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const { rows } = await client.query(
      'SELECT 1 FROM platform_admins WHERE lower(email) = lower($1)',
      [adminEmail],
    );
    await client.end();

    if (rows.length > 0) {
      // Already there. bootstrap-admin refuses to overwrite an existing
      // account without FORCE_RESET, and rightly so — but this runs on every
      // `docker compose up`, so asking it and failing would mean the API
      // never starts a second time.
      ok(`${adminEmail} already exists`);
    } else {
      const created = run('node', [path.join('scripts', 'bootstrap-admin.js')]);
      if (created !== 0) {
        die('could not create the platform administrator — the error is above.');
      }
      // bootstrap-admin prints the address and never the password. Say where
      // to use it; the console is a different port from the API and a first
      // run has no other way to find that out.
      const consoleUrl = process.env.ADMIN_BASE_URL || 'http://localhost:5174';
      ok(`sign in at ${consoleUrl}`);
    }
  }

  step('ready');
  console.log(`  ${D}The API may now start.${X}\n`);
}

main().catch((e) => die(e.stack || e.message));
