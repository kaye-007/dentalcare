/* eslint-disable no-console */
/**
 * Shared production guard for the data scripts.
 *
 * Both seed-demo and reset-demo write credentials and destroy data. Run
 * against a live database either would be unrecoverable, so they refuse to
 * touch anything that is not obviously a local or explicitly-approved
 * development database.
 */
const fs = require('fs');
const path = require('path');

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres', 'host.docker.internal'];

/**
 * @param {string} connectionString
 * @param {{ overrideVar?: string, action?: string }} [opts]
 */
function assertNotProduction(connectionString, opts = {}) {
  const overrideVar = opts.overrideVar || 'ALLOW_REMOTE_SEED';
  const action = opts.action || 'seed';

  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Refusing to ${action}: NODE_ENV=production.`);
  }

  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection string.');
  }

  // WHATWG URL returns an IPv6 host wrapped in brackets — "[::1]" — so the
  // "::1" entry in LOCAL_HOSTS could never match and an IPv6 loopback
  // connection was refused as "non-local". Safe direction to fail in, but
  // still wrong: strip the brackets before comparing.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const dbName = url.pathname.replace(/^\//, '');

  if (/prod/i.test(dbName) || /prod/i.test(host)) {
    throw new Error(`Refusing to ${action}: "${host}/${dbName}" looks like production.`);
  }
  if (!LOCAL_HOSTS.includes(host) && process.env[overrideVar] !== 'yes') {
    throw new Error(
      `Refusing to ${action} a non-local database (${host}).\n` +
        `  If you really mean it, set ${overrideVar}=yes.`,
    );
  }

  return { host, dbName };
}


/**
 * Refuse to touch a database whose schema is behind the migrations on disk.
 *
 * Without this, a stale database fails on the first INSERT that needs a column
 * a missing migration would have added -- "column \"position\" of relation
 * \"users\" does not exist" -- which names a symptom four steps removed from
 * the cause. A developer then has to know that `position` arrives in 0011 to
 * work out that their database stopped at 0010.
 *
 * @param {import('pg').ClientBase} client
 * @param {string} [migrationsDir]
 */
async function assertSchemaCurrent(client, migrationsDir) {
  const dir = migrationsDir || path.resolve(__dirname, '..', '..', 'migrations');
  const onDisk = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.js$/.test(f))
    .map((f) => f.replace(/\.js$/, ''))
    .sort();

  let applied;
  try {
    const { rows } = await client.query('SELECT name FROM pgmigrations');
    applied = new Set(rows.map((r) => r.name));
  } catch {
    throw new Error(
      'This database has no schema yet -- it has never been migrated.\n' +
        '  Run:  npm run dev:setup      (database, role, migrations and demo data)',
    );
  }

  const missing = onDisk.filter((name) => !applied.has(name));
  if (missing.length === 0) return;

  throw new Error(
    `This database is ${missing.length} migration(s) behind the repository.\n` +
      `  First missing:  ${missing[0]}\n` +
      `  Latest on disk: ${onDisk[onDisk.length - 1]}\n` +
      '  Run:  npm run migrate:up     (or npm run dev:setup:reset to rebuild from scratch)',
  );
}

module.exports = { assertNotProduction, assertSchemaCurrent, LOCAL_HOSTS };
