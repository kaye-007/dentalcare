/**
 * Restore a backup into an EMPTY database, and prove it came back whole.
 *
 *   npm run db:restore -- --from backups/<x>.dump --into <database url>
 *   npm run db:restore -- --from backups/<x>.dump --into <database url> --check
 *
 * ── Never over data ───────────────────────────────────────────────────────
 *
 * The target must hold no tables. Restoring over the live database would
 * roll every clinic back at once; the way back from a disaster is a restore
 * into a new database, checked, and then the application pointed at it, as
 * docs/DEPLOYMENT.md describes. --check re-runs the checks on a database
 * already restored, without touching it.
 *
 * ── What "whole" means ────────────────────────────────────────────────────
 *
 *   1. the archive is the one its manifest describes (SHA-256)
 *   2. the schema is exactly the one the source had
 *   3. the last migration and every table's row count match the source
 *   4. row security is enabled and forced on every table with a tenant_id,
 *      and the tenant role cannot bypass it
 *
 * Any difference fails the run. --into must be the privileged role: it
 * creates objects and loads rows with row security off. The tenant role is
 * created when the server lacks it, as the migrations would, with LOGIN
 * only if APP_DB_PASSWORD is set.
 */
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  pgTool,
  schemaOf,
  factsOf,
  compareFacts,
  isolationProblems,
  describe,
} = require('./lib/pg-tools');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const CHECK_ONLY = process.argv.includes('--check');
const APP_USER = process.env.APP_DB_USER || 'app_user';

/** The first lines where two schemas part, for a person to read. */
function firstDifferences(expected, actual, max = 12) {
  const a = expected.split('\n');
  const b = new Set(actual.split('\n'));
  const e = new Set(a);
  return [
    ...a.filter((l) => !b.has(l)).map((l) => `- ${l}`),
    ...actual
      .split('\n')
      .filter((l) => !e.has(l))
      .map((l) => `+ ${l}`),
  ].slice(0, max);
}

/**
 * PostgreSQL stores a CHECK as a parsed expression and prints it back when
 * dumped. A dump and restore re-parses that text, and nested ANDs come back
 * flattened: `((a AND b) AND c)` returns as `(a AND b AND c)`. The meaning is
 * the same, the text is not, so a byte comparison would fail every real
 * restore. When the only lines that differ are the same once parentheses and
 * spacing are set aside, this returns how many; otherwise null, and the
 * difference is reported. pg_restore does not rewrite what an expression
 * means, and every table, column, constraint, index, grant and policy still
 * has to be there, word for word.
 */
function reparsedOnly(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const inB = new Set(b);
  const inA = new Set(a);
  const onlyA = a.filter((l) => !inB.has(l));
  const onlyB = b.filter((l) => !inA.has(l));
  if (onlyA.length !== onlyB.length || onlyA.length === 0) return null;
  const canon = (l) => l.replace(/[()\s]/g, '');
  const ca = onlyA.map(canon).sort();
  const cb = onlyB.map(canon).sort();
  return ca.every((l, i) => l === cb[i]) ? onlyA.length : null;
}

async function ensureTenantRole(client) {
  if (!/^[a-z_][a-z0-9_]*$/.test(APP_USER))
    throw new Error(`Unusable role name ${APP_USER}`);
  const found = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
    APP_USER,
  ]);
  if (found.rowCount) return false;
  const password = process.env.APP_DB_PASSWORD;
  const login = password ? `LOGIN PASSWORD '${password.replace(/'/g, "''")}'` : 'NOLOGIN';
  await client.query(`CREATE ROLE "${APP_USER}" ${login} NOSUPERUSER NOBYPASSRLS`);
  return true;
}

async function main() {
  const from = arg('--from');
  const into = arg('--into');
  if (!from || !into) {
    throw new Error(
      'Usage: db-restore --from <backup.dump> --into <database url> [--check]',
    );
  }

  const archive = fs.readFileSync(from);
  const manifest = JSON.parse(fs.readFileSync(`${from}.json`, 'utf8'));
  const expectedSchema = fs.readFileSync(`${from}.schema.sql`, 'utf8').trimEnd();
  const problems = [];

  console.log(`${B}Restore check${X}  ${path.basename(from)} -> ${describe(into)}`);
  console.log(
    `${D}Backup of ${manifest.source} at ${manifest.createdAt}, migration ${manifest.migration}${X}`,
  );

  // 1. The archive is the one the manifest describes.
  const sha = createHash('sha256').update(archive).digest('hex');
  if (sha !== manifest.sha256) {
    throw new Error(
      'The archive does not match its manifest (SHA-256). Not restoring it.',
    );
  }
  console.log(`  ${G}ok${X}    archive matches its manifest`);

  if (!CHECK_ONLY) {
    const { Client } = require('pg');
    const client = new Client({ connectionString: into });
    await client.connect();
    try {
      const tables = Number(
        (
          await client.query(
            `SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`,
          )
        ).rows[0].n,
      );
      if (tables > 0) {
        throw new Error(
          `${describe(into)} already holds ${tables} tables. A restore goes into an empty database.`,
        );
      }
      if (await ensureTenantRole(client)) {
        console.log(
          `  ${G}ok${X}    created role ${APP_USER} (it was missing on this server)`,
        );
      }
    } finally {
      await client.end();
    }

    const started = Date.now();
    pgTool(
      'pg_restore',
      ['--no-owner', '--exit-on-error', '--single-transaction'],
      into,
      {
        input: archive,
      },
    );
    console.log(
      `  ${G}ok${X}    restored in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  }

  // 2. The schema is the source's.
  const schema = schemaOf(into);
  const reprinted = reparsedOnly(expectedSchema, schema);
  if (schema === expectedSchema) {
    console.log(`  ${G}ok${X}    schema identical to the source's`);
  } else if (reprinted !== null) {
    console.log(
      `  ${G}ok${X}    schema identical to the source's (${reprinted} line(s) re-printed by PostgreSQL with other parentheses)`,
    );
  } else {
    problems.push('schema differs from the source:');
    problems.push(...firstDifferences(expectedSchema, schema).map((l) => `    ${l}`));
  }

  // 3. Migration and rows.
  const facts = await factsOf(into);
  const factProblems = compareFacts(manifest, facts);
  if (factProblems.length === 0) {
    const rows = Object.values(facts.tables).reduce((a, b) => a + b, 0);
    console.log(
      `  ${G}ok${X}    ${Object.keys(facts.tables).length} tables, ${rows} rows, migration ${facts.migration}: all match`,
    );
  } else problems.push(...factProblems);

  // 4. Isolation.
  const iso = await isolationProblems(into, APP_USER);
  if (iso.problems.length === 0) {
    console.log(
      `  ${G}ok${X}    row security enabled and forced on all ${iso.tenantTables} tenant tables; ${APP_USER} cannot bypass it`,
    );
  } else problems.push(...iso.problems);

  if (problems.length) {
    console.error(`\n${R}NOT WHOLE${X}`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`\n${G}Restored whole.${X}`);
}

main().catch((e) => {
  console.error(`${R}Restore failed${X}  ${e.message}`);
  process.exit(1);
});
