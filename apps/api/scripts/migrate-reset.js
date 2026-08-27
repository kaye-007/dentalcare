#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * migrate:reset — drop every table and rebuild the schema from migrations.
 *
 * ── Why this drops the schema instead of migrating down ───────────────────
 *
 * The obvious implementation is `node-pg-migrate down` nineteen times. It
 * cannot work here, and deliberately so:
 *
 *   1. `clinic_audit_log` carries BEFORE UPDATE / DELETE / TRUNCATE triggers
 *      that raise. Triggers fire for the table owner too, so nothing short of
 *      disabling them can empty that table row by row.
 *   2. Migration 0018's down() aborts outright once the log holds anything,
 *      so that a routine rollback can never silently destroy the record of who
 *      took, reversed or repriced what.
 *
 * Both are correct. They exist to stop history being erased by accident. A
 * reset is the one case where erasure is the entire point, so it says so out
 * loud: `DROP SCHEMA public CASCADE` removes the tables themselves rather than
 * their contents, which no row-level trigger can intercept.
 *
 * The consequence to be clear about: this is not "clear the test data". It is
 * "there was never a database here". Every clinic, every patient, every
 * invoice and the whole audit trail go together.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *
 * Guarded by the same `assertNotProduction` used by the seed scripts: refuses
 * when NODE_ENV=production, when the host or database name looks like
 * production, and against any non-local host unless ALLOW_REMOTE_RESET=yes.
 *
 * That guard is now load-bearing for a destructive operation, so its tests are
 * reinstated alongside it in lib/guard.spec.ts.
 *
 * Usage:
 *   npm run migrate:reset            # drop, rebuild, stop
 *   npm run migrate:reset -- --seed  # …then run the demo seed
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { assertNotProduction } = require('./lib/guard');

const ENV_PATH = path.resolve(__dirname, '../../../.env');
require('dotenv').config({ path: ENV_PATH });

const API_DIR = path.resolve(__dirname, '..');
const WITH_SEED = process.argv.includes('--seed');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env before resetting.',
    );
  }

  // Throws unless this is plainly a development database.
  const { host, dbName } = assertNotProduction(url, {
    overrideVar: 'ALLOW_REMOTE_RESET',
    action: 'reset',
  });

  console.log(c.bold('\nmigrate:reset'));
  console.log(c.dim(`  target   ${host}/${dbName}`));
  console.log(
    c.red('  destroys  every clinic, patient, invoice and audit entry'),
  );

  const db = new Client({ connectionString: url });
  await db.connect();

  try {
    // Counted before the drop so the output states what was actually lost,
    // rather than a reassuring "reset complete" over an unknown quantity.
    const before = await countRows(db);
    if (before) {
      console.log(
        c.dim(
          `  existing  ${before.tenants} clinic(s), ${before.users} user(s), ` +
            `${before.patients} patient(s), ${before.audit} audit entr(ies)`,
        ),
      );
    }

    // CASCADE takes the tables with it, which no row-level trigger can block.
    // pgmigrations lives in public too, so the migration runner starts clean.
    await db.query('DROP SCHEMA IF EXISTS public CASCADE');
    await db.query('CREATE SCHEMA public');

    // Migration 0001 recreates the extensions (pgcrypto, btree_gist) and 0003
    // re-creates app_user and re-grants it, so nothing else needs restoring.
    // The role itself survives — it is cluster-level, not schema-level.
    console.log(c.dim('  dropped   schema public'));
  } finally {
    await db.end();
  }

  console.log(c.dim('  rebuilding from migrations…\n'));
  execFileSync(
    process.execPath,
    [
      require.resolve('node-pg-migrate/bin/node-pg-migrate'),
      'up',
      '-m',
      'migrations',
      '--envPath',
      ENV_PATH,
    ],
    { cwd: API_DIR, stdio: 'inherit' },
  );

  if (WITH_SEED) {
    console.log(c.dim('\n  seeding demo data…\n'));
    execFileSync(process.execPath, [path.join(__dirname, 'seed-demo.js')], {
      cwd: API_DIR,
      stdio: 'inherit',
    });
  }

  console.log(c.green('\n✓ reset complete'));
  console.log(
    c.dim(
      WITH_SEED
        ? '  The demo clinic is available again.\n'
        : '  The database has schema and no accounts. Create the first platform\n' +
            '  administrator before the console can be used — see\n' +
            '  docs/DEPLOYMENT.md § First platform administrator.\n',
    ),
  );
}

/** Best-effort pre-drop census. Returns null on a database with no schema yet. */
async function countRows(db) {
  try {
    const { rows } = await db.query(`
      SELECT (SELECT count(*) FROM tenants)::int           AS tenants,
             (SELECT count(*) FROM users)::int             AS users,
             (SELECT count(*) FROM patients)::int          AS patients,
             (SELECT count(*) FROM clinic_audit_log)::int  AS audit
    `);
    return rows[0];
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(c.red(`\n✗ ${err.message}\n`));
  process.exitCode = 1;
});
