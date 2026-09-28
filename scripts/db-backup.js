/**
 * A logical backup of the whole database, with what a restore is checked
 * against written beside it.
 *
 *   npm run db:backup                         # into backups/
 *   npm run db:backup -- --out <file.dump>
 *
 * ── What it is for ────────────────────────────────────────────────────────
 *
 * Not instead of the database provider's point-in-time recovery. It is the
 * copy that can be restored anywhere, checked end to end
 * (scripts/db-restore.js), and kept away from the provider that holds the
 * original. It contains every clinic's patient records: store it encrypted,
 * never in the repository (backups/ is git-ignored).
 *
 * ── How ───────────────────────────────────────────────────────────────────
 *
 * DATABASE_URL: the privileged role that migrations use. Row security is
 * forced on every tenant table, so only a role that bypasses it sees every
 * clinic's rows; this runs with row_security off, so any other role fails
 * loudly instead of writing a backup that silently missed rows.
 *
 * The row counts are taken inside the very snapshot pg_dump reads (an
 * exported snapshot), so on a live database the manifest still matches the
 * archive exactly.
 *
 * Writes three files:
 *   <out>             pg_dump custom format, for pg_restore
 *   <out>.json        last migration, row count per table, SHA-256 of <out>
 *   <out>.schema.sql  the schema, as a restore must reproduce it
 *
 * Uploaded documents are not in the database. Back up the bucket (turn on
 * versioning) or, on a server disk, STORAGE_DIR: see docs/DEPLOYMENT.md.
 */
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { pgTool, factsWithin, normaliseSchema, describe } = require('./lib/pg-tools');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const X = '\x1b[0m';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.resolve(
    arg('--out') ?? path.join(__dirname, '..', 'backups', `dentalcare-${stamp}.dump`),
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  console.log(`${D}Backing up ${describe(url)} to ${out}${X}`);

  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  let facts;
  let archive;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET row_security = off');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS s')).rows[0].s;
    facts = await factsWithin(client);
    // While this transaction holds the snapshot open, pg_dump reads the same one.
    archive = pgTool('pg_dump', ['--format=custom', `--snapshot=${snapshot}`], url, {
      binary: true,
    });
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
  const schema = normaliseSchema(pgTool('pg_dump', ['--schema-only', '--no-owner'], url));

  fs.writeFileSync(out, archive);
  const manifest = {
    createdAt: new Date().toISOString(),
    source: describe(url),
    migration: facts.migration,
    bytes: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
    tables: facts.tables,
  };
  fs.writeFileSync(`${out}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(`${out}.schema.sql`, `${schema}\n`);

  const rows = Object.values(facts.tables).reduce((a, b) => a + b, 0);
  console.log(
    `${G}Backed up${X} ${Object.keys(facts.tables).length} tables, ${rows} rows, ` +
      `${(archive.length / 1024).toFixed(0)} KiB, at migration ${facts.migration}.`,
  );
  console.log(`${D}SHA-256 ${manifest.sha256}${X}`);
}

main().catch((e) => {
  console.error(`${R}Backup failed${X}  ${e.message}`);
  process.exit(1);
});
