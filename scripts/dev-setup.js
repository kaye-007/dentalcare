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
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const bcrypt = require('bcryptjs');
const { Client } = require('pg');

/** Credentials that appear in this repository. Never acceptable as a real one. */
const PUBLISHED_PASSWORDS = [
  'Demo@2026!',
  'Admin123!',
  'Owner123!',
  'Reception123!',
  'changeme',
  'password',
];

const RESET = process.argv.includes('--reset');
// Demo data is opt-in. A clean database with the schema, the app role and
// your own administrator is the normal case; the demo clinic is a
// fixture for exercising the UI, not something to hand a real deployment.
const WITH_DEMO = process.argv.includes('--with-demo');

const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const info = (m) => console.log(`  ..    ${m}`);
const warn = (m) => console.log(`  \x1b[33mwarn\x1b[0m  ${m}`);
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const die = (m) => {
  console.error(`\n  \x1b[31mFAILED\x1b[0m  ${m}\n`);
  process.exit(1);
};

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

/* ── first-clinic helpers ─────────────────────────────────────────────── */

/** A terminal on both ends. A pipe or a CI job gets no prompts. */
function interactive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function ask(question) {
  if (!interactive()) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    }),
  );
}

/**
 * Same, without echoing. A password typed into a terminal ends up in
 * scrollback and in whatever is scraping the pane; the point of asking for it
 * rather than generating and printing one is that it never gets written down.
 */
function askSecret(question) {
  if (!interactive()) return Promise.resolve('');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  let muted = false;
  rl._writeToOutput = (s) => {
    if (!muted) return rl.output.write(s);
    // Keep the newline, hide everything else, so Enter still ends the line.
    if (s.includes('\n')) rl.output.write('\n');
  };
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    });
    muted = true;
  });
}

/** Subdomains become hostnames: avicena.dentalcare.app. Keep them to that. */
function validateSubdomain(value) {
  const s = String(value).trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(s)) {
    return 'letters, digits and hyphens only, 1-32 characters, not starting or ending with a hyphen';
  }
  // 'www' is the one label TenantMiddleware deliberately refuses to read as a
  // clinic, so a clinic called www would resolve on localhost and nowhere else.
  if (s === 'www' || s === 'api' || s === 'admin') {
    return `"${s}" is reserved — it names something other than a clinic in production`;
  }
  return null;
}

/**
 * Create the clinic and the account that administers it, in one transaction.
 *
 * Deliberately mirrors what the platform console does rather than inventing a
 * second shape: a tenant row, and a `users` row with role 'admin' — the
 * doctor, who is also the administrator, under the two-role model 0017
 * settled on.
 */
async function createFirstClinic(client, io = { ask, askSecret }) {
  const rawName = (await io.ask('  Clinic name:      ')).trim();
  const name = rawName || 'My Clinic';

  const suggestion =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'clinic';

  let subdomain;
  for (;;) {
    const answer =
      (await io.ask(`  Subdomain:        [${suggestion}] `)).trim() || suggestion;
    const problem = validateSubdomain(answer);
    if (problem) {
      warn(problem);
      continue;
    }
    const taken = await client.query('SELECT 1 FROM tenants WHERE subdomain = $1', [
      answer.toLowerCase(),
    ]);
    if (taken.rowCount > 0) {
      warn(`"${answer}" is already taken`);
      continue;
    }
    subdomain = answer.toLowerCase();
    break;
  }

  const email = (await io.ask('  Your email:       ')).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    die(`"${email}" is not an email address.`);
  }
  const fullName = (await io.ask('  Your name:        ')).trim() || email.split('@')[0];

  let password;
  for (;;) {
    password = await io.askSecret('  Password:         ');
    if (password.length < 12) {
      warn('at least 12 characters');
      continue;
    }
    if (PUBLISHED_PASSWORDS.some((p) => p.toLowerCase() === password.toLowerCase())) {
      warn('that password is published in this repository — choose another');
      continue;
    }
    const again = await io.askSecret('  Again:            ');
    if (again !== password) {
      warn('they do not match');
      continue;
    }
    break;
  }

  const hash = await bcrypt.hash(password, 10);

  await client.query('BEGIN');
  try {
    const t = await client.query(
      `INSERT INTO tenants (name, subdomain, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [name, subdomain],
    );
    const tenantId = t.rows[0].id;
    await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
       VALUES ($1, $2, $3, $4, 'admin', 'active')`,
      [tenantId, email, hash, fullName],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    die(`could not create the clinic: ${e.message}`);
  }

  ok(`created "${name}" (${subdomain}) with ${email} as its administrator`);
  writeEnvVar('DEV_TENANT_SUBDOMAIN', subdomain);
  ok(`.env now points localhost at "${subdomain}"`);
}

/**
 * Set one variable in .env, in place.
 *
 * Rewrites the existing line if there is one — including a commented-out one,
 * so `# DEV_TENANT_SUBDOMAIN=demo` does not end up shadowed by a second live
 * copy further down — and appends otherwise. Everything else in the file,
 * comments included, is left exactly as it was.
 */
function writeEnvVar(key, value, envPath = path.resolve(__dirname, '../.env')) {
  if (!fs.existsSync(envPath)) {
    warn(`.env not found — set ${key}=${value} by hand`);
    return;
  }
  const original = fs.readFileSync(envPath, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const re = new RegExp(`^\\s*#?\\s*${key}\\s*=`);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      lines[i] = `${key}=${value}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(`${key}=${value}`);
  fs.writeFileSync(envPath, lines.join(eol));
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
    die(
      `DATABASE_URL points at "${dbName}" but APP_DATABASE_URL points at ` +
        `"${decodeURIComponent(appUrl.pathname.slice(1))}". They must be the same database.`,
    );
  }
  if (process.env.APP_DB_PASSWORD && process.env.APP_DB_PASSWORD !== appPass) {
    warn(
      'APP_DB_PASSWORD does not match the password inside APP_DATABASE_URL. ' +
        'APP_DATABASE_URL is what the API actually uses, so that is what will be applied.',
    );
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
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await maint.query(`DROP DATABASE IF EXISTS ${ident(dbName)}`);
    ok('dropped');
  }

  const exists = await maint.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    dbName,
  ]);
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
  const role = await maint.query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [appUser],
  );
  if (role.rowCount === 0) {
    await maint.query(
      `CREATE ROLE ${ident(appUser)} LOGIN PASSWORD ${lit(appPass)}
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    ok(`created role ${appUser}`);
  } else {
    await maint.query(
      `ALTER ROLE ${ident(appUser)} WITH LOGIN PASSWORD ${lit(appPass)} NOSUPERUSER NOBYPASSRLS`,
    );
    ok(`role ${appUser} existed — password re-synced to .env`);
    if (role.rows[0].rolsuper || role.rows[0].rolbypassrls) {
      warn(
        `${appUser} was a superuser or had BYPASSRLS. Removed — RLS is the whole point of that role.`,
      );
    }
  }
  await maint.end();

  /* ── 4. migrations ──────────────────────────────────────────────────── */
  step('4. migrations');
  try {
    execSync('npm run migrate:up', {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
    });
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
  await admin.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(appUser)}`,
  );
  await admin.query(
    `GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO ${ident(appUser)}`,
  );

  /* Tables the app role is meant to hold nothing on. Without this list the
     "no privileges at all" test below would read them as an out-of-band gap
     and grant exactly what 0004 and 0021 revoked. */
  const DENIED_BY_DESIGN = new Set([
    'platform_admins',
    'audit_log',
    'pgmigrations',
    // 0005: console sessions and second factors belong to the platform plane.
    'platform_sessions',
    'platform_mfa_factors',
    'platform_mfa_recovery_codes',
  ]);

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
    ok(
      `granted DML on ${missing.length} table(s) created outside a migration: ${missing.join(', ')}`,
    );
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
           OR (table_name = 'clinic_audit_log' AND privilege_type IN ('UPDATE','DELETE','TRUNCATE'))
           -- 0004: nothing clinical is deleted, notes are written once, and
           -- the record-access log is append-only.
           OR (table_name IN ('patients','tooth_conditions','clinical_procedures',
                              'perio_exams','perio_measurements','perio_tooth_findings',
                              'patient_notes','patient_allergies','patient_conditions',
                              'patient_medications')
               AND privilege_type = 'DELETE')
           OR (table_name = 'patient_notes' AND privilege_type = 'UPDATE')
           OR (table_name = 'patient_access_log' AND privilege_type IN ('UPDATE','DELETE','TRUNCATE'))
           -- 0005: nothing on the console's sessions or factors, and a clinic
           -- factor's secret is never rewritten in place.
           OR (table_name IN ('platform_sessions','platform_mfa_factors','platform_mfa_recovery_codes'))
           OR (table_name IN ('user_mfa_factors','user_mfa_recovery_codes')
               AND privilege_type IN ('UPDATE','DELETE'))
           -- 0002 and 0007: stock history is append-only, nothing stocked is
           -- deleted, and a lot keeps the identity it was received with (its
           -- UPDATE grant is per column, so a table-wide one is a regression).
           OR (table_name = 'stock_movements' AND privilege_type IN ('UPDATE','DELETE'))
           OR (table_name IN ('inventory_items','inventory_lots') AND privilege_type = 'DELETE')
           OR (table_name = 'inventory_lots' AND privilege_type = 'UPDATE')
           -- 0008: a reminder row is the record that a patient was contacted.
           OR (table_name = 'reminders' AND privilege_type = 'DELETE') )
      ORDER BY table_name, privilege_type`,
    [appUser],
  );
  if (forbidden.rowCount > 0) {
    for (const row of forbidden.rows) {
      warn(
        `${appUser} holds ${row.privilege_type} on ${row.table_name}, which a migration revoked`,
      );
    }
    die('the app role is over-privileged — rebuild with: npm run dev:setup:reset');
  }
  ok(
    'money, audit, clinical-record, stock and commercial-state privileges are still revoked',
  );
  await admin.end();

  /* ── 6. demo data ───────────────────────────────────────────────────── */
  if (WITH_DEMO) {
    step('6. demo data');
    try {
      // --with-demo is the explicit opt-in the seed's DEMO_ENV guard asks
      // for, so it is set for this one command and nowhere else.
      execSync('npm run seed -w @dentalcare/api', {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'inherit',
        env: { ...process.env, DEMO_ENV: 'true' },
      });
    } catch {
      die('seed failed — the error is above.');
    }
  }

  /* ── 7. the first clinic ────────────────────────────────────────────── */
  /* The gap this closes: everything above can succeed and leave a database
     with a schema, an app role, correct grants — and no clinic. The clinic
     app resolves localhost through DEV_TENANT_SUBDOMAIN, so with no clinic
     matching it every request 404s in TenantMiddleware before login is
     reached, and the browser shows a failed sign-in for a password that was
     never compared. `ready` used to print instructions for fixing that by
     hand; it is one prompt instead.

     Not the demo clinic. `--with-demo` still exists and still seeds the demo clinic
     with a year of history; this makes YOUR clinic, with your account, which
     is what a real first run wants. */
  step('7. clinic');
  if (!WITH_DEMO) {
    const admin2 = await connect(adminUrlRaw, 'admin');
    const existing = await admin2.query(
      'SELECT subdomain, status FROM tenants ORDER BY created_at',
    );
    const wanted = (process.env.DEV_TENANT_SUBDOMAIN || '').toLowerCase();
    const match = existing.rows.find((t) => t.subdomain === wanted);

    if (match) {
      ok(`DEV_TENANT_SUBDOMAIN "${wanted}" -> ${match.status}`);
    } else if (existing.rowCount > 0) {
      const names = existing.rows.map((t) => t.subdomain).join(', ');
      if (wanted) {
        warn(`DEV_TENANT_SUBDOMAIN is "${wanted}" and no clinic has that subdomain.`);
      } else {
        warn('DEV_TENANT_SUBDOMAIN is not set.');
      }
      if (!interactive()) {
        // ask() answers '' with nobody at the keyboard, and taking that as
        // "yes, the first one" would rewrite .env in a CI job. Say what to
        // set and carry on to the verification below, which is the part that
        // matters without a terminal.
        warn(`Set DEV_TENANT_SUBDOMAIN to one of: ${names}`);
      } else {
        const pick = await ask(
          `  Point .env at which clinic? (${names}) [${existing.rows[0].subdomain}] `,
        );
        const chosen = (pick || existing.rows[0].subdomain).toLowerCase();
        if (existing.rows.some((t) => t.subdomain === chosen)) {
          writeEnvVar('DEV_TENANT_SUBDOMAIN', chosen);
          ok(`.env now points at "${chosen}"`);
        } else {
          warn(`no clinic called "${chosen}" — .env left alone`);
        }
      }
    } else if (!interactive()) {
      // A pipe, a CI job, a container. Say what is missing and move on; a
      // prompt with nobody to answer it is a hang, not a feature.
      warn('no clinics exist. Run this again from a terminal to create one,');
      warn('or create one from the platform console on :5174.');
    } else {
      info('no clinics exist yet');
      const create = await ask('  Create one now? [Y/n] ');
      if (/^n/i.test(create.trim())) {
        info('skipped — create one from the platform console on :5174');
      } else {
        await createFirstClinic(admin2);
      }
    }
    await admin2.end();
  } else {
    ok('demo clinic seeded above');
  }

  /* ── 8. verify the way the API will actually connect ────────────────── */
  /* Everything above can succeed and login still 500 if the app role cannot
     log in. Prove it here, as app_user, not as the admin. */
  step('8. verification (as the API sees it)');
  const app = await connect(appUrlRaw, appUser);

  // resolve_tenant(p_subdomain) RETURNS TABLE (id uuid, status text) — it is
  // GIVEN the subdomain, so it does not hand one back. Selecting it here was
  // asking for a column the function has never returned.
  const wantSubdomain = process.env.DEV_TENANT_SUBDOMAIN || 'demo';
  const tenant = await app.query('SELECT id, status FROM resolve_tenant($1)', [
    wantSubdomain,
  ]);

  // No clinic yet is the normal state of a fresh database -- you create the
  // first one from the admin console. Only the RLS check below is mandatory.
  if (tenant.rowCount === 0) {
    ok(`app role connects; nothing resolves for "${wantSubdomain}"`);
    const rls0 = await app.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
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
  console.log(
    '        ' +
      Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join('  '),
  );

  const roles = await app.query(
    'SELECT role, count(*)::int AS c FROM users GROUP BY role ORDER BY role',
  );
  ok('roles: ' + (roles.rows.map((r) => `${r.role}×${r.c}`).join(', ') || 'none'));

  const admins = roles.rows.find((r) => r.role === 'admin');
  if (!admins) warn('no admin user — you will not be able to reach Settings or Staff.');
  if (counts.tooth_conditions === 0)
    warn('no charted findings — the odontogram will be empty.');

  const rls = await app.query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
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

  Demo clinic  ->  demo@dentx.app / Demo@2026!   (all demo accounts: docs/DEMO_ACCOUNTS.md)
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

if (require.main === module) {
  main().catch((e) => die(e.message));
}

// Exported so the pieces with real logic in them — subdomain rules, the .env
// rewrite, and clinic creation itself — can be tested without a terminal.
module.exports = { validateSubdomain, writeEnvVar, createFirstClinic };
