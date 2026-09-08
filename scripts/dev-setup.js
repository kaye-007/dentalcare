/* eslint-disable no-console */
/**
 * One command to take a local machine from nothing to a working demo.
 *
 *   node scripts/dev-setup.js            # converge whatever is there
 *   node scripts/dev-setup.js --reset    # drop the database first, start clean
 *
 * Every step is idempotent and every step is verified. It exists because the
 * setup has several failure modes that all present identically as a 500 at
 * login, and telling them apart by hand is miserable:
 *
 *   - the database does not exist
 *   - the app_user role does not exist
 *   - the app_user role exists with a password that no longer matches .env
 *     (roles are CLUSTER-wide but databases are not, so dropping the database
 *      leaves a stale role behind and migration 0003 skips it)
 *   - the role cannot see tables created by later migrations
 *   - migrations ran but the seed did not
 *
 * Uses pg directly rather than psql, so it works whether Postgres is a local
 * install or a container, and needs nothing on PATH.
 */
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { Client } = require('pg');

const RESET = process.argv.includes('--reset');
// Demo data is opt-in. A clean database with the schema, the app role and
// your own administrator is the normal case; the Vienna demo clinic is a
// fixture for exercising the UI, not something to hand a real deployment.
const WITH_DEMO = process.argv.includes('--with-demo');

const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const info = (m) => console.log(`  ..    ${m}`);
const warn = (m) => console.log(`  \x1b[33mwarn\x1b[0m  ${m}`);
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const die = (m) => { console.error(`\n  \x1b[31mFAILED\x1b[0m  ${m}\n`); process.exit(1); };

/** Single-quoted SQL literal. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** Double-quoted SQL identifier. */
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`${name} is not set in .env. Copy .env.example to .env and fill it in.`);
  return v;
}

async function connect(connectionString, label) {
  const c = new Client({ connectionString });
  try {
    await c.connect();
    return c;
  } catch (e) {
    die(`could not connect as ${label}: ${e.message}`);
  }
}

async function main() {
  console.log('\n\x1b[1mDentalCare — local setup\x1b[0m');

  /* ── 1. read and validate the environment ───────────────────────────── */
  step('1. environment');
  const adminUrlRaw = requireEnv('DATABASE_URL');
  const appUrlRaw = requireEnv('APP_DATABASE_URL');
  requireEnv('JWT_SECRET');

  const adminUrl = new URL(adminUrlRaw);
  const appUrl = new URL(appUrlRaw);
  const dbName = decodeURIComponent(adminUrl.pathname.slice(1));
  const appUser = decodeURIComponent(appUrl.username);
  const appPass = decodeURIComponent(appUrl.password);

  if (!dbName) die('DATABASE_URL has no database name.');
  if (decodeURIComponent(appUrl.pathname.slice(1)) !== dbName) {
    die(`DATABASE_URL points at "${dbName}" but APP_DATABASE_URL points at ` +
        `"${decodeURIComponent(appUrl.pathname.slice(1))}". They must be the same database.`);
  }
  if (process.env.APP_DB_PASSWORD && process.env.APP_DB_PASSWORD !== appPass) {
    warn('APP_DB_PASSWORD does not match the password inside APP_DATABASE_URL. ' +
         'APP_DATABASE_URL is what the API actually uses, so that is what will be applied.');
  }
  ok(`database ${dbName} on ${adminUrl.hostname}:${adminUrl.port || 5432}`);
  ok(`admin role ${decodeURIComponent(adminUrl.username)} · app role ${appUser}`);

  /* ── 2. the database itself ─────────────────────────────────────────── */
  step('2. database');
  const maintUrl = new URL(adminUrlRaw);
  maintUrl.pathname = '/postgres';
  const maint = await connect(maintUrl.toString(), 'admin (postgres db)');

  if (RESET) {
    info(`--reset given, dropping ${dbName}`);
    await maint.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await maint.query(`DROP DATABASE IF EXISTS ${ident(dbName)}`);
    ok('dropped');
  }

  const exists = await maint.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) {
    await maint.query(`CREATE DATABASE ${ident(dbName)}`);
    ok(`created ${dbName}`);
  } else {
    ok(`${dbName} present`);
  }

  /* ── 3. the application role ────────────────────────────────────────── */
  /* The important one. A role lives in the CLUSTER, not the database, so a
     dropped database leaves it behind with whatever password it was born
     with. Converge it rather than assume it. */
  step('3. application role');
  const role = await maint.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [appUser]);
  if (role.rowCount === 0) {
    await maint.query(
      `CREATE ROLE ${ident(appUser)} LOGIN PASSWORD ${lit(appPass)}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    ok(`created role ${appUser}`);
  } else {
    await maint.query(`ALTER ROLE ${ident(appUser)} WITH LOGIN PASSWORD ${lit(appPass)} NOSUPERUSER NOBYPASSRLS`);
    ok(`role ${appUser} existed — password re-synced to .env`);
    if (role.rows[0].rolsuper || role.rows[0].rolbypassrls) {
      warn(`${appUser} was a superuser or had BYPASSRLS. Removed — RLS is the whole point of that role.`);
    }
  }
  await maint.end();

  /* ── 4. migrations ──────────────────────────────────────────────────── */
  step('4. migrations');
  try {
    execSync('npm run migrate:up', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    ok('schema up to date');
  } catch {
    die('migrations failed — the error is above.');
  }

  /* ── 5. grants ──────────────────────────────────────────────────────── */
  /* Migration 0003 sets default privileges, which cover every table a later
     migration creates as the same owner. What they do not cover is a table
     created out of band, so this looks for tables the app role cannot touch
     at all and grants only those.

     What used to be here was

         GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public

     which is indiscriminate. It handed back DELETE on payments and invoices,
     UPDATE on ledger_entries, UPDATE and DELETE on clinic_audit_log, and
     UPDATE and DELETE on tenants — every privilege 0004, 0018 and 0021
     deliberately take away. Running dev-setup therefore undid the database's
     own money-immutability and commercial-state guarantees, reported "can
     read and write every table in public" as if that were the goal, and left
     the local database quietly weaker than the migrations describe. */
  step('5. grants');
  const admin = await connect(adminUrlRaw, 'admin');
  await admin.query(`GRANT CONNECT ON DATABASE ${ident(dbName)} TO ${ident(appUser)}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${ident(appUser)}`);
  await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(appUser)}`);
  await admin.query(`GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO ${ident(appUser)}`);

  /* Tables the app role is meant to hold nothing on. Without this list the
     "no privileges at all" test below would read them as an out-of-band gap
     and grant exactly what 0004 and 0021 revoked. */
  const DENIED_BY_DESIGN = new Set(['platform_admins', 'audit_log', 'pgmigrations']);

  const orphans = await admin.query(
    `SELECT t.tablename
       FROM pg_tables t
      WHERE t.schemaname = 'public'
        AND NOT EXISTS (
              SELECT 1 FROM information_schema.table_privileges p
               WHERE p.table_schema = 'public'
                 AND p.table_name = t.tablename
                 AND p.grantee = $1)
        AND NOT EXISTS (
              SELECT 1 FROM information_schema.column_privileges c
               WHERE c.table_schema = 'public'
                 AND c.table_name = t.tablename
                 AND c.grantee = $1)
      ORDER BY t.tablename`,
    [appUser],
  );
  const missing = orphans.rows
    .map((r) => r.tablename)
    .filter((name) => !DENIED_BY_DESIGN.has(name));

  for (const table of missing) {
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${ident(table)} TO ${ident(appUser)}`,
    );
  }
  if (missing.length > 0) {
    ok(`granted DML on ${missing.length} table(s) created outside a migration: ${missing.join(', ')}`);
  } else {
    ok('every table already carries the grants its migration gave it');
  }

  /* Prove the deliberate narrowings survived. A privilege that is supposed to
     be absent is worth checking precisely because nothing fails when it is
     present — the app never issues those statements, so the only symptom of
     losing this boundary is that it is gone. */
  const forbidden = await admin.query(
    `SELECT table_name, privilege_type
       FROM information_schema.table_privileges
      WHERE grantee = $1
        AND table_schema = 'public'
        AND ( (table_name = 'tenants'          AND privilege_type IN ('UPDATE','DELETE'))
           OR (table_name = 'plans'            AND privilege_type IN ('INSERT','UPDATE','DELETE'))
           OR (table_name = 'pgmigrations')
           OR (table_name = 'platform_admins')
           OR (table_name = 'audit_log')
           OR (table_name IN ('payments','invoices','expenses','ledger_entries')
               AND privilege_type = 'DELETE')
           OR (table_name IN ('payments','expenses','ledger_entries')
               AND privilege_type = 'UPDATE')
           OR (table_name = 'clinic_audit_log' AND privilege_type IN ('UPDATE','DELETE','TRUNCATE')) )
      ORDER BY table_name, privilege_type`,
    [appUser],
  );
  if (forbidden.rowCount > 0) {
    for (const row of forbidden.rows) {
      warn(`${appUser} holds ${row.privilege_type} on ${row.table_name}, which a migration revoked`);
    }
    die('the app role is over-privileged — rebuild with: npm run dev:reset');
  }
  ok('money, audit and commercial-state privileges are still revoked');
  await admin.end();

  /* ── 6. demo data ───────────────────────────────────────────────────── */
  if (WITH_DEMO) {
    step('6. demo data');
    try {
      execSync('npm run seed -w @dentalcare/api', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    } catch {
      die('seed failed — the error is above.');
    }
  }

  /* ── 7. verify the way the API will actually connect ────────────────── */
  /* Everything above can succeed and login still 500 if the app role cannot
     log in. Prove it here, as app_user, not as the admin. */
  step('7. verification (as the API sees it)');
  const app = await connect(appUrlRaw, appUser);

  // resolve_tenant(p_subdomain) RETURNS TABLE (id uuid, status text) — it is
  // GIVEN the subdomain, so it does not hand one back. Selecting it here was
  // asking for a column the function has never returned.
  const wantSubdomain = process.env.DEV_TENANT_SUBDOMAIN || 'demo';
  const tenant = await app.query('SELECT id, status FROM resolve_tenant($1)', [wantSubdomain]);

  // No clinic yet is the normal state of a fresh database -- you create the
  // first one from the admin console. Only the RLS check below is mandatory.
  if (tenant.rowCount === 0) {
    ok('app role connects; no clinic exists yet');
    const rls0 = await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    if (rls0.rows[0].rolsuper || rls0.rows[0].rolbypassrls) {
      warn('the app role can bypass RLS — tenant isolation is NOT enforced.');
    } else {
      ok('RLS is enforced for the app role');
    }
    await app.end();
    return ready(false);
  }
  ok(`resolve_tenant('${wantSubdomain}') -> ${tenant.rows[0].status}`);

  const tid = tenant.rows[0].id;
  await app.query('SELECT set_config($1,$2,false)', ['app.current_tenant_id', tid]);

  const counts = {};
  for (const t of ['users', 'patients', 'appointments', 'invoices', 'tooth_conditions']) {
    const r = await app.query(`SELECT count(*)::int AS c FROM ${ident(t)}`);
    counts[t] = r.rows[0].c;
  }
  console.log('        ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));

  const roles = await app.query('SELECT role, count(*)::int AS c FROM users GROUP BY role ORDER BY role');
  ok('roles: ' + (roles.rows.map((r) => `${r.role}×${r.c}`).join(', ') || 'none'));

  const admins = roles.rows.find((r) => r.role === 'admin');
  if (!admins) warn('no admin user — you will not be able to reach Settings or Staff.');
  if (counts.tooth_conditions === 0) warn('no charted findings — the odontogram will be empty.');

  const rls = await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  if (rls.rows[0].rolsuper || rls.rows[0].rolbypassrls) {
    warn('the app role can bypass RLS — tenant isolation is NOT enforced.');
  } else {
    ok('RLS is enforced for the app role');
  }
  await app.end();

  ready(WITH_DEMO);
}

/** What to do next, which differs depending on whether there is any data. */
function ready(seeded) {
  step('ready');
  if (seeded) {
    console.log(`
  Three terminals, all from the repo root:

    npm run api:dev      ->  API      http://localhost:3000
    npm run web:dev      ->  clinic   http://localhost:5173
    npm run admin:dev    ->  console  http://localhost:5174

  Demo clinic  ->  demo@dentx.app / Demo@2026!
  Demo console ->  admin@dentx.app / Demo@2026!
`);
    return;
  }
  console.log(`
  The database has your schema and the app role, and no data. Next:

    npm run admin:create     create your own platform administrator

  Then, from the repo root:

    npm run api:dev      ->  API      http://localhost:3000
    npm run admin:dev    ->  console  http://localhost:5174
    npm run web:dev      ->  clinic   http://localhost:5173

  Sign in to the console with the account you just made, create your first
  clinic there, then set DEV_TENANT_SUBDOMAIN in .env to its subdomain so
  localhost:5173 knows which clinic it is.

  Demo data, if you ever want it:  npm run dev:setup -- --with-demo
`);
}

main().catch((e) => die(e.message));
