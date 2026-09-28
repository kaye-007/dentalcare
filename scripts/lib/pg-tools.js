/**
 * What the backup and restore scripts share: PostgreSQL's own client tools,
 * and the facts about a database a restore is checked against.
 *
 * pg_dump and pg_restore come from PATH when they are installed there, and
 * otherwise from the postgres image (PG_TOOLS_IMAGE, postgres:16-alpine by
 * default, the one compose runs). The client must be at least the server's
 * major version, so point PG_TOOLS_IMAGE at a newer image for a newer server.
 * Archives pass through stdin and stdout, so the container needs no mounts.
 */
const { spawnSync } = require('child_process');

const IMAGE = process.env.PG_TOOLS_IMAGE || 'postgres:16-alpine';

/** Inside a container, localhost is the container. */
const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];

function forDocker(url) {
  const u = new URL(url);
  if (LOOPBACK.includes(u.hostname)) u.hostname = 'host.docker.internal';
  return u.toString();
}

/**
 * Run pg_dump / pg_restore with `--dbname=<url>`. Falls back to the image
 * only when the tool is not installed; a tool that runs and fails is a
 * failure, not a reason to try something else.
 */
function pgTool(tool, args, url, { input, binary = false } = {}) {
  const opts = {
    input,
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 2 * 1024 * 1024 * 1024,
  };
  const local = spawnSync(tool, [...args, `--dbname=${url}`], opts);
  const result =
    local.error && local.error.code === 'ENOENT'
      ? spawnSync(
          'docker',
          [
            'run',
            '--rm',
            ...(input ? ['-i'] : []),
            '--add-host=host.docker.internal:host-gateway',
            IMAGE,
            tool,
            ...args,
            `--dbname=${forDocker(url)}`,
          ],
          opts,
        )
      : local;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${tool} failed:\n${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

/**
 * A schema-only dump reduced to what a restore must reproduce: no comments,
 * no psql session settings, no \restrict key (random per run since
 * PostgreSQL 16.10), no ownership.
 */
function schemaOf(url) {
  return normaliseSchema(pgTool('pg_dump', ['--schema-only', '--no-owner'], url));
}

function normaliseSchema(dump) {
  return dump
    .split('\n')
    .filter(
      (line) =>
        line.trim() !== '' &&
        !line.startsWith('--') &&
        !/^\\(restrict|unrestrict)\b/.test(line) &&
        !line.startsWith('SET ') &&
        !line.startsWith("SELECT pg_catalog.set_config('search_path'"),
    )
    .join('\n');
}

/**
 * What a restore is checked against: the last migration and the row count of
 * every table. Read with row security off, so a role that could not see
 * every clinic's rows fails here instead of recording zeros.
 */
async function factsOf(url) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SET row_security = off');
    return await factsWithin(client);
  } finally {
    await client.end();
  }
}

/** The same facts, on a connection the caller holds (inside its snapshot). */
async function factsWithin(client) {
  const tables = (
    await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    )
  ).rows.map((r) => r.tablename);
  const counts = {};
  for (const t of tables) {
    counts[t] = Number(
      (await client.query(`SELECT count(*)::text AS n FROM public."${t}"`)).rows[0].n,
    );
  }
  const migration = tables.includes('pgmigrations')
    ? ((await client.query('SELECT max(name) AS m FROM pgmigrations')).rows[0].m ?? null)
    : null;
  return { migration, tables: counts };
}

/**
 * Row security as the isolation model needs it on a restored database:
 * every table with a tenant_id column enabled and forced, and the tenant
 * role unable to bypass it. Returns what is wrong, or nothing.
 */
async function isolationProblems(url, appUser) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const problems = [];
    const { rows } = await client.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                         AND NOT a.attisdropped)
        ORDER BY c.relname`,
    );
    for (const r of rows) {
      if (!r.relrowsecurity || !r.relforcerowsecurity) {
        problems.push(`${r.relname}: row security not enabled and forced`);
      }
    }
    const role = (
      await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
        [appUser],
      )
    ).rows[0];
    if (!role) problems.push(`role ${appUser} does not exist`);
    else if (role.rolsuper || role.rolbypassrls) {
      problems.push(`role ${appUser} can bypass row security`);
    }
    return { problems, tenantTables: rows.length };
  } finally {
    await client.end();
  }
}

/** Differences between what the source had and what came back. */
function compareFacts(expected, actual) {
  const out = [];
  if (expected.migration !== actual.migration) {
    out.push(`last migration: ${actual.migration}, expected ${expected.migration}`);
  }
  const names = new Set([...Object.keys(expected.tables), ...Object.keys(actual.tables)]);
  for (const t of [...names].sort()) {
    const e = expected.tables[t];
    const a = actual.tables[t];
    if (e === undefined) out.push(`${t}: not in the backup`);
    else if (a === undefined) out.push(`${t}: missing`);
    else if (e !== a) out.push(`${t}: ${a} rows, expected ${e}`);
  }
  return out;
}

/** "host:port/db", never the credentials, for anything printed. */
function describe(url) {
  const u = new URL(url);
  return `${u.hostname}:${u.port || 5432}${u.pathname}`;
}

module.exports = {
  pgTool,
  schemaOf,
  normaliseSchema,
  factsOf,
  factsWithin,
  compareFacts,
  isolationProblems,
  describe,
};
