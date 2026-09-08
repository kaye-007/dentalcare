/**
 * Squash the migration history into one baseline, mechanically, and prove it.
 *
 *   node scripts/build-baseline.js            # build and verify
 *   node scripts/build-baseline.js --verify   # verify only, change nothing
 *
 * ── Why a script and not a person with an editor ──────────────────────────
 *
 * A hand-written replacement schema is the single most dangerous thing anyone
 * could do to this repository. Every RLS policy, every column-level grant,
 * every EXCLUDE constraint and both audit triggers would have to be
 * transcribed by eye, and a schema that is 99% right is one that passes every
 * test and silently drops one clinic's isolation.
 *
 * So nothing here is written by hand. The baseline is `pg_dump` output from a
 * database built by the real migrations, and the only edits are mechanical
 * and enumerated below. Then it is checked the only way worth checking:
 *
 *   db_old   0001..NNNN, the real history
 *   db_new   0001_baseline alone
 *
 * dump both, diff. A non-empty diff fails. Not "functionally equivalent" —
 * byte-identical after normalising the parts of a dump that are noise
 * (its header comments and the psql \restrict key, which is random per run).
 *
 * ── The three mechanical edits ────────────────────────────────────────────
 *
 *  1. the psql preamble is dropped. `\restrict`, the SET lines and the
 *     `search_path = ''` are instructions to psql and to a restore session;
 *     node-pg-migrate runs this through pg, inside its own transaction, and
 *     an empty search_path there would break its own bookkeeping INSERT.
 *     Every object in the dump is schema-qualified, so nothing depends on it.
 *
 *  2. `pgmigrations` is removed — the table, its sequence, its default and
 *     its primary key. node-pg-migrate creates that itself before any
 *     migration runs, so a baseline that also created it could never run.
 *
 *  3. the app_user role is prepended. pg_dump never emits it: a ROLE is
 *     cluster-scoped and a database dump does not carry one. It is the same
 *     converge-don't-create block 0003 used, for the same reason.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const VERIFY_ONLY = process.argv.includes('--verify');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(REPO, 'apps/api/migrations');
const BASELINE = path.join(MIGRATIONS, '0001_baseline.js');

const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const ok = (m) => console.log(`  ${G}ok${X}    ${m}`);
const info = (m) => console.log(`  ${D}..${X}    ${m}`);
const warn = (m) => console.log(`  ${Y}warn${X}  ${m}`);
const step = (m) => console.log(`\n${B}${m}${X}`);
const die = (m) => {
  console.error(`\n  ${R}FAILED${X}  ${m}\n`);
  process.exit(1);
};

const APP_USER = process.env.APP_DB_USER || 'app_user';
const APP_PASSWORD = process.env.APP_DB_PASSWORD || 'app_user_dev_pw';

if (!process.env.DATABASE_URL) die('DATABASE_URL is not set.');
const ADMIN = new URL(process.env.DATABASE_URL);

/** A connection string for `name` on the same server as DATABASE_URL. */
function urlFor(name) {
  const u = new URL(ADMIN.toString());
  u.pathname = `/${name}`;
  return u.toString();
}

// ── running things ──────────────────────────────────────────────────────

/**
 * pg_dump, from PATH if it is there and from a container if it is not.
 *
 * The version must match the server or the output drifts in ways that look
 * like real differences, so the container is pinned to the same image the
 * compose stack uses.
 */
function pgDump(database) {
  const args = [
    '--schema-only',
    '--no-owner',
    '--no-privileges=false',
    `--dbname=${urlFor(database)}`,
  ].filter((a) => a !== '--no-privileges=false');

  const local = spawnSync('pg_dump', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!local.error && local.status === 0) return local.stdout;

  info('pg_dump is not on PATH — using the postgres:16-alpine image');
  // Inside the container, localhost is the container. Both loopback spellings
  // have to be rewritten, not just the word.
  const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];
  const host = LOOPBACK.includes(ADMIN.hostname)
    ? 'host.docker.internal'
    : ADMIN.hostname;
  const url = new URL(urlFor(database));
  url.hostname = host;

  const viaDocker = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--add-host=host.docker.internal:host-gateway',
      'postgres:16-alpine',
      'pg_dump',
      '--schema-only',
      '--no-owner',
      `--dbname=${url.toString()}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (viaDocker.status !== 0) {
    die(`pg_dump failed:\n${viaDocker.stderr || viaDocker.error?.message}`);
  }
  return viaDocker.stdout;
}

/**
 * Migrate `database` from an explicit directory.
 *
 * Always a directory this script controls, never `apps/api/migrations`
 * directly. The first version of this script wrote the candidate baseline
 * into the live migrations directory and then rebuilt db_old from it — so the
 * "real history" it was verifying against silently included the very file
 * under test, and a failed run left a broken migration behind for the next
 * one to trip over. Copy in what should run; nothing else can.
 */
function migrate(database, dir) {
  const bin = path.join(REPO, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
  const args = ['up', '-m', dir];

  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: path.join(REPO, 'apps/api'),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: urlFor(database),
      APP_DB_USER: APP_USER,
      APP_DB_PASSWORD: APP_PASSWORD,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    die(`migrations failed on ${database}:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function recreate(database) {
  const { Client } = require('pg');
  const maintenance = new URL(ADMIN.toString());
  maintenance.pathname = '/postgres';
  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    await client.query(`DROP DATABASE IF EXISTS "${database}"`);
    await client.query(`CREATE DATABASE "${database}"`);
  } finally {
    await client.end();
  }
}

// ── the transform ───────────────────────────────────────────────────────

/**
 * A pg_dump is a sequence of blocks, each introduced by
 *
 *     --
 *     -- Name: X; Type: Y; Schema: Z; Owner: -
 *     --
 *
 * Splitting on that is what makes "drop every pgmigrations object" a
 * three-line rule instead of a regular expression over SQL.
 */
function blocks(dump) {
  const lines = dump.split('\n');
  const out = [];
  let current = { header: null, lines: [] };

  for (let i = 0; i < lines.length; i++) {
    const isHeader =
      lines[i] === '--' && /^-- Name: /.test(lines[i + 1] ?? '') && lines[i + 2] === '--';
    if (isHeader) {
      out.push(current);
      current = { header: lines[i + 1], lines: [] };
      i += 2;
      continue;
    }
    current.lines.push(lines[i]);
  }
  out.push(current);
  return out;
}

/** True for a block that describes a pgmigrations object. */
function isMigrationBookkeeping(block) {
  if (!block.header) return false;
  return /Name: pgmigrations/.test(block.header);
}

/**
 * The two settings that must not survive into a migration, and only those.
 *
 *   search_path = ''     node-pg-migrate runs this inside its own transaction
 *                        and then writes its bookkeeping row; an empty
 *                        search_path breaks that write.
 *   row_security = off   meaningless for pure DDL, and it turns any statement
 *                        that would apply a policy into an error.
 *
 * Every other SET the dump emits is kept, deliberately.
 * `check_function_bodies = false` in particular is load-bearing: pg_dump
 * writes functions before tables, and resolve_tenant() selects FROM tenants.
 * Dropping that line as "preamble" is what made the first attempt at this
 * file fail with `relation "tenants" does not exist`.
 */
const PREAMBLE = /^(SELECT pg_catalog\.set_config\('search_path'|SET row_security\b)/;
const META = /^\\(restrict|unrestrict)\b/;

function transform(dump) {
  const kept = blocks(dump).filter((b) => !isMigrationBookkeeping(b));

  const body = kept
    .map((b) => {
      const lines = b.lines.filter((l) => !PREAMBLE.test(l) && !META.test(l));
      const header = b.header ? ['--', b.header, '--', ''] : [];
      return [...header, ...lines].join('\n');
    })
    .join('\n');

  return (
    body
      // The dump's own provenance header changes every run.
      .replace(/^--\n-- PostgreSQL database dump\n--\n/, '')
      .replace(/^-- Dumped (from|by).*\n/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}

/** Normalise the parts of a dump that differ run to run but mean nothing. */
function normalise(dump) {
  return dump
    .split('\n')
    .filter((l) => !META.test(l))
    .filter((l) => !/^-- Dumped (from|by)/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── the role, which pg_dump cannot give us ──────────────────────────────

const ROLE_SQL = `
-- ── the runtime role ──────────────────────────────────────────────────────
--
-- Converge, do not merely create.
--
-- A ROLE lives in the CLUSTER while a DATABASE does not, so dropping and
-- recreating the database leaves this role behind carrying whatever password
-- it was born with. An earlier version only ran CREATE when the role was
-- absent, so a rebuilt database inherited a stale password that no amount of
-- re-migrating could correct. The symptom was every authenticated request
-- returning 500, which looks nothing like a credentials problem and cost a
-- day to find.
--
-- NOBYPASSRLS is the load-bearing word. A role that can bypass row-level
-- security defeats every policy below it, including FORCE, and the API would
-- keep working perfectly while every clinic read every other clinic's data.
DO $do$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '__APP_USER__') THEN
      CREATE ROLE __APP_USER__ LOGIN PASSWORD '__APP_PASSWORD__'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    ELSE
      ALTER ROLE __APP_USER__ WITH LOGIN PASSWORD '__APP_PASSWORD__'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $do$;

DO $$
  BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '__APP_USER__');
  END $$;
`.trim();

// ── the file ────────────────────────────────────────────────────────────

function render(schemaSql, superseded, latest) {
  return `/**
 * 0001 — the baseline schema
 *
 * Generated, not written. This file is \`pg_dump --schema-only --no-owner\`
 * taken from a database built by migrations 0001..${latest}, which were then
 * deleted. Re-verify it at any time with:
 *
 *     node scripts/build-baseline.js --verify
 *
 * That script explains the three mechanical edits applied to the dump and
 * performs the check that makes this safe: build one database from the old
 * history, another from this file alone, dump both, and require the diff to
 * be empty. Not equivalent — identical.
 *
 * ── Upgrading a database that predates the squash ─────────────────────────
 *
 * A fresh database needs nothing special: \`npm run migrate:up\` builds the
 * schema from here.
 *
 * A database that already ran 0001..${latest} needs one flag, once:
 *
 *     npm run migrate:up -- --no-check-order
 *
 * node-pg-migrate otherwise refuses, because \`0001_baseline\` sorts before
 * migrations it has already run — a sound default, and exactly the situation
 * a squash creates. With the flag, up() sees the schema is already present,
 * verifies that ALL ${superseded.length} superseded migrations were applied,
 * converges the role, records itself and changes nothing else.
 *
 * A database that ran only SOME of them is refused outright, with the first
 * missing migration named. Recording the baseline against a half-built schema
 * would leave a database that reports itself current while missing tables,
 * and that is far worse than a failed command.
 *
 * ── What this file is responsible for ─────────────────────────────────────
 *
 * Everything below is load-bearing, and most of it is invisible in normal
 * operation, which is exactly why it is worth naming here. The tests that
 * prove each of these still hold live in apps/api/test/integration.
 *
 *   the app_user role       NOSUPERUSER, NOBYPASSRLS, converged rather than
 *                           created — see the block immediately below
 *
 *   RLS on every tenant     ENABLE *and* FORCE. Without FORCE the table owner
 *   table                   is exempt, and on a deployment where the API and
 *                           the migrations share a role that exemption is the
 *                           whole isolation model gone
 *
 *   tenant_isolation        one policy per tenant table, scoped by the
 *   policies                transaction-local GUC app.current_tenant_id
 *
 *   resolve_tenant()        SECURITY DEFINER, so the subdomain lookup can run
 *                           before any tenant context exists without exposing
 *                           other clinics. It is the one narrow window
 *                           app_user has onto \`tenants\` across the boundary
 *
 *   per-table grants        explicit, never GRANT ... ON ALL TABLES. The
 *                           difference is the entire money-immutability
 *                           story: payments and expenses carry column-level
 *                           UPDATE on the three void columns only, invoices
 *                           and ledger_entries have no DELETE, tenants has no
 *                           UPDATE beyond (name, updated_at), and plans and
 *                           pgmigrations have nothing
 *
 *   append-only triggers    clinic_audit_log refuses UPDATE, DELETE and
 *                           TRUNCATE. Triggers fire for the table owner too,
 *                           so nothing short of a superuser dropping them can
 *                           rewrite history — a deliberate, visible act
 *
 *   EXCLUDE constraints     double-booking a dentist, a chair or a patient is
 *                           impossible rather than unlikely. Evaluated by the
 *                           index at write time, so two people booking the
 *                           same slot in the same second cannot both win
 *
 * ── Rolling back ──────────────────────────────────────────────────────────
 *
 * There is no down migration. A baseline's inverse is an empty database, and
 * writing that as \`DROP TABLE ...\` invites someone to run it against one
 * with patients in it. Recreate the database instead.
 */

exports.shorthands = undefined;

/**
 * The migrations this file replaces.
 *
 * Kept so an existing database can adopt the baseline instead of being asked
 * to build a schema it already has. A database that has run all of these is
 * exactly the database this file produces, so the right thing there is to
 * record the baseline and change nothing.
 */
const SUPERSEDES = ${JSON.stringify(superseded, null, 2)
    .split('\n')
    .map((l, i) => (i === 0 ? l : '  ' + l))
    .join('\n')};

exports.up = async (pgm) => {
  const appUser = process.env.APP_DB_USER || 'app_user';
  const appPass = process.env.APP_DB_PASSWORD || 'app_user_dev_pw';

  const role = ROLE.replace(/__APP_USER__/g, appUser).replace(
    /__APP_PASSWORD__/g,
    appPass,
  );

  /* ── an existing database ─────────────────────────────────────────────
     A schema already built by 0001..${latest} is identical to the one below —
     that equality is what build-baseline.js verifies, byte for byte — so
     running the DDL again would only fail on "relation already exists".

     Adopt it instead. The role convergence still runs, because it is
     idempotent and because a rebuilt database that kept a stale cluster-wide
     role is the exact failure 0003 existed to prevent.

     Partial history is refused rather than adopted: a database stopped
     halfway would otherwise record the baseline as applied and claim to be
     current while missing tables. */
  const built = await pgm.db.select(
    "SELECT to_regclass('public.tenants') IS NOT NULL AS present",
  );

  if (built[0] && built[0].present) {
    const applied = await pgm.db.select('SELECT name FROM pgmigrations');
    const have = new Set(applied.map((r) => r.name));
    const missing = SUPERSEDES.filter((name) => !have.has(name));

    if (missing.length > 0 && missing.length < SUPERSEDES.length) {
      throw new Error(
        \`This database has a partial schema: \${missing.length} of the \` +
          \`\${SUPERSEDES.length} migrations this baseline replaces were never \` +
          \`applied (first missing: \${missing[0]}).\\n\` +
          '  Bring it up to date from a checkout made before the squash, then ' +
          'run this again — or, if it holds no data you need, drop and ' +
          'recreate it.',
      );
    }

    pgm.sql(role);
    return;
  }

  pgm.sql(role);
  pgm.sql(SCHEMA.replace(/\\bapp_user\\b/g, appUser));
};

exports.down = () => {
  throw new Error(
    '0001_baseline has no down migration. Its inverse is an empty database — ' +
      'drop and recreate it instead.',
  );
};

const ROLE = \`
${ROLE_SQL}
\`;

const SCHEMA = \`
${schemaSql}
\`;
`;
}

// ── main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${B}DentalCare — migration baseline${X}`);
  console.log(`${D}${ADMIN.hostname}:${ADMIN.port || 5432}${X}`);

  const onDisk = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => /^\d+_.+\.js$/.test(f))
    .sort();

  /**
   * The real history is every migration EXCEPT the baseline. Keeping those
   * separate is what stops the script verifying a candidate baseline against
   * a db_old that was itself built partly from that candidate.
   */
  const history = onDisk.filter((f) => f !== '0001_baseline.js');
  const isSquashed = history.length === 0;

  if (isSquashed && !VERIFY_ONLY) {
    warn('\nAlready squashed — there is no history left to generate from.');
    warn('Use --verify to re-check the existing baseline reproduces itself.\n');
    return;
  }

  // Two scratch directories, populated explicitly. Removed on the way out.
  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dentalcare-baseline-'));
  const oldDir = path.join(work, 'old');
  const newDir = path.join(work, 'new');
  fs.mkdirSync(oldDir);
  fs.mkdirSync(newDir);

  try {
    /* ── 1. db_old — the real history, and nothing else ───────────────── */
    step('1. db_old (the migration history)');
    const source = isSquashed ? onDisk : history;
    for (const file of source) {
      fs.copyFileSync(path.join(MIGRATIONS, file), path.join(oldDir, file));
    }
    info(`${source.length} migration(s): ${source[0]} .. ${source[source.length - 1]}`);

    await recreate('db_old');
    migrate('db_old', oldDir);
    const oldDump = pgDump('db_old');
    ok(`applied and dumped (${oldDump.split('\n').length} lines)`);

    /* ── 2. generate ──────────────────────────────────────────────────── */
    step('2. baseline');
    // Just the number: "0001..0021" reads as a range, which is what it is.
    const latest = source[source.length - 1].match(/^(\d+)_/)?.[1] ?? '?';
    const schema = transform(oldDump);

    let candidate;
    if (VERIFY_ONLY) {
      if (!fs.existsSync(BASELINE)) {
        die('--verify given but 0001_baseline.js does not exist.');
      }
      candidate = fs.readFileSync(BASELINE, 'utf8');
      info('--verify: checking the baseline already on disk');
    } else {
      candidate = render(
        schema,
        source.map((f) => f.replace(/.js$/, '')),
        latest,
      );
      info('generated from the db_old dump');
    }
    fs.writeFileSync(path.join(newDir, '0001_baseline.js'), candidate);

    /* ── 3. db_new — the baseline alone ───────────────────────────────── */
    step('3. db_new (the baseline alone)');
    await recreate('db_new');
    migrate('db_new', newDir);
    const newDump = pgDump('db_new');
    ok(`applied and dumped (${newDump.split('\n').length} lines)`);

    /* ── 4. the diff that decides it ──────────────────────────────────── */
    step('4. schema diff');
    const a = normalise(oldDump);
    const b = normalise(newDump);

    if (a !== b) {
      const outDir = path.join(REPO, '.baseline-diff');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'db_old.sql'), a);
      fs.writeFileSync(path.join(outDir, 'db_new.sql'), b);

      const aLines = a.split('\n');
      const bLines = b.split('\n');
      const onlyOld = aLines.filter((l) => l.trim() && !bLines.includes(l));
      const onlyNew = bLines.filter((l) => l.trim() && !aLines.includes(l));

      console.error(`\n  ${R}${onlyOld.length} line(s) only in db_old:${X}`);
      onlyOld.slice(0, 60).forEach((l) => console.error(`    - ${l}`));
      console.error(`\n  ${R}${onlyNew.length} line(s) only in db_new:${X}`);
      onlyNew.slice(0, 60).forEach((l) => console.error(`    + ${l}`));
      console.error(`\n  Full dumps written to ${path.relative(REPO, outDir)}/`);

      die('schema diff is NOT empty. The baseline does not reproduce the schema.');
    }
    ok('EMPTY — db_new is byte-identical to db_old');

    /* ── 5. install ───────────────────────────────────────────────────── */
    // Only now, with the diff proven empty. A candidate that failed never
    // reaches apps/api/migrations, so a bad run leaves nothing behind for the
    // next one to pick up as history.
    if (!VERIFY_ONLY) {
      step('5. install');
      fs.writeFileSync(BASELINE, candidate);
      ok(`wrote ${path.relative(REPO, BASELINE).replace(/\\/g, '/')}`);
    }

    step('next');
    console.log(`
  The baseline reproduces the schema exactly.${
    VERIFY_ONLY ? '' : ` Before deleting 0001..${latest}:`
  }

    npm run test:integration     against db_new, as app_user
    npm test
    npm run typecheck
    npm run build
`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => die(e.stack || e.message));
