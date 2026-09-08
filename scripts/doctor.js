/**
 * One command that answers "why can't I log in?".
 *
 *   node scripts/doctor.js
 *
 * Both login screens fail identically from the browser -- a red box saying
 * "Internal Server Error" -- while the cause can be any of eight things, in
 * two completely separate code paths:
 *
 *   the clinic app  (:5173)  ->  users + tenants, as app_user, under RLS
 *   the admin console (:5174) ->  platform_admins, as the owner role, no RLS
 *
 * diagnose-login.js walks the first path. Nothing walked the second, which is
 * why a missing platform_admins table read as a mystery 500 for an hour.
 *
 * This checks both, stops at nothing, and prints the one command that fixes
 * whatever it found. It only ever reads.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { Client } = require('pg');
const { assertSchemaCurrent } = require('../apps/api/scripts/lib/guard');

const G = '\x1b[32m',
  R = '\x1b[31m',
  Y = '\x1b[33m',
  D = '\x1b[2m',
  B = '\x1b[1m',
  X = '\x1b[0m';
const ok = (m) => console.log(`  ${G}ok${X}    ${m}`);
const bad = (m) => console.log(`  ${R}FAIL${X}  ${m}`);
const warn = (m) => console.log(`  ${Y}warn${X}  ${m}`);
const info = (m) => console.log(`  ${D}..${X}    ${m}`);
const head = (m) => console.log(`\n${B}${m}${X}`);

/** Problems worth fixing, in the order they must be fixed. */
const problems = [];
const problem = (what, fix) => problems.push({ what, fix });

async function tryConnect(url, label) {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await c.connect();
    return c;
  } catch (e) {
    bad(`${label}: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log(`\n${B}DentalCare doctor${X}`);
  console.log(`${D}Reads only. Nothing here changes your data.${X}`);

  /* ── 1. configuration ────────────────────────────────────────────── */
  head('1. configuration (.env)');

  const adminUrl = process.env.DATABASE_URL;
  const appUrl = process.env.APP_DATABASE_URL;

  if (!adminUrl) {
    bad('DATABASE_URL is not set');
    problem('no .env', 'Copy-Item .env.example .env   then fill it in');
    return report();
  }
  ok(`DATABASE_URL -> ${adminUrl.replace(/:[^:@/]*@/, ':****@')}`);

  if (!appUrl) {
    warn('APP_DATABASE_URL is not set — the clinic app falls back to the owner role,');
    warn('which means Row-Level Security is NOT enforced locally.');
    problem('APP_DATABASE_URL missing', 'npm run dev:setup');
  } else {
    ok('APP_DATABASE_URL is set');
  }

  if (!process.env.JWT_SECRET) {
    bad('JWT_SECRET is not set — the API will refuse to start');
    problem('JWT_SECRET missing', 'add JWT_SECRET to .env (32+ characters)');
  } else if (process.env.JWT_SECRET.length < 16) {
    bad(`JWT_SECRET is only ${process.env.JWT_SECRET.length} characters`);
    problem('JWT_SECRET too short', 'make JWT_SECRET at least 32 characters in .env');
  } else {
    ok(`JWT_SECRET present (${process.env.JWT_SECRET.length} characters)`);
  }

  // The console signs cross-tenant tokens. Development may share JWT_SECRET;
  // production may not, and finding that out at deploy time is the expensive
  // way to find it out.
  if (!process.env.PLATFORM_JWT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      bad('PLATFORM_JWT_SECRET is not set — the API will refuse to start in production');
      problem(
        'PLATFORM_JWT_SECRET missing',
        'add PLATFORM_JWT_SECRET to .env (32+ characters, different from JWT_SECRET)',
      );
    } else {
      ok(
        'PLATFORM_JWT_SECRET unset — console falls back to JWT_SECRET (development only)',
      );
    }
  } else if (process.env.PLATFORM_JWT_SECRET === process.env.JWT_SECRET) {
    bad('PLATFORM_JWT_SECRET is the same value as JWT_SECRET — that is not a split');
    problem('platform secret not separated', 'generate a different PLATFORM_JWT_SECRET');
  } else {
    ok(
      `PLATFORM_JWT_SECRET present (${process.env.PLATFORM_JWT_SECRET.length} characters)`,
    );
  }

  if (!process.env.DEV_TENANT_SUBDOMAIN || process.env.ALLOW_TENANT_HEADER !== '1') {
    warn('DEV_TENANT_SUBDOMAIN / ALLOW_TENANT_HEADER=1 not both set.');
    warn(
      'localhost has no subdomain, so the clinic app cannot resolve a clinic without them.',
    );
    problem(
      'clinic app cannot resolve a tenant on localhost',
      'set DEV_TENANT_SUBDOMAIN and ALLOW_TENANT_HEADER=1 in .env',
    );
  } else {
    ok(`clinic on localhost resolves to "${process.env.DEV_TENANT_SUBDOMAIN}"`);
  }

  /* ── 2. database ─────────────────────────────────────────────────── */
  head('2. database');

  const admin = await tryConnect(adminUrl, 'cannot connect as the owner role');
  if (!admin) {
    problem('database unreachable', 'docker compose up -d postgres');
    return report();
  }
  ok('connected as the owner role');

  try {
    await assertSchemaCurrent(admin);
    ok('schema is up to date with the migrations on disk');
  } catch (e) {
    bad(e.message.split('\n')[0]);
    e.message
      .split('\n')
      .slice(1)
      .forEach((l) => info(l.trim()));
    problem('schema behind', 'npm run dev:setup:reset');
    await admin.end();
    return report();
  }

  /* ── 3. the application role ─────────────────────────────────────── */
  head('3. application role (what the clinic app connects as)');

  if (appUrl) {
    const app = await tryConnect(appUrl, 'cannot connect as app_user');
    if (!app) {
      problem(
        'app_user cannot connect',
        'npm run dev:setup   (it converges the role password to match .env)',
      );
    } else {
      const { rows } = await app.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      const role = rows[0] || {};
      if (role.rolsuper || role.rolbypassrls) {
        bad('app_user is a superuser or holds BYPASSRLS — clinic isolation is OFF');
        problem('app_user over-privileged', 'npm run dev:setup:reset');
      } else {
        ok('app_user connects and cannot bypass Row-Level Security');
      }
      await app.end();
    }
  }

  /* ── 4. the admin console login ──────────────────────────────────── */
  head('4. admin console  ->  localhost:5174');

  let admins = null;
  try {
    const { rows } = await admin.query(
      `SELECT email, status, password_hash IS NOT NULL AS has_password
         FROM platform_admins ORDER BY created_at`,
    );
    admins = rows;
  } catch (e) {
    bad(`platform_admins is unreadable: ${e.message}`);
    problem('platform_admins missing', 'npm run dev:setup:reset');
  }

  if (admins) {
    if (admins.length === 0) {
      bad('no platform administrators exist — there is nothing to log in as');
      problem('no admin account', 'npm run admin:create');
    } else {
      ok(`${admins.length} platform administrator(s):`);
      for (const a of admins) {
        const flag =
          a.status !== 'active'
            ? `${R}${a.status}${X}`
            : !a.has_password
              ? `${R}no password${X}`
              : `${G}active${X}`;
        console.log(`          ${a.email}  ${flag}`);
      }
      if (!admins.some((a) => a.status === 'active' && a.has_password)) {
        problem('no usable admin account', 'npm run admin:create');
      }
    }
  }

  /* ── 5. the clinic app login ─────────────────────────────────────── */
  head('5. clinic app  ->  localhost:5173');

  try {
    const { rows } = await admin.query(
      `SELECT t.subdomain, t.status,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS staff
         FROM tenants t ORDER BY t.created_at`,
    );
    if (rows.length === 0) {
      warn('no clinics exist yet — normal on a fresh database');
      info('create one from the admin console once you can sign in there');
    } else {
      ok(`${rows.length} clinic(s):`);
      for (const t of rows) {
        console.log(`          ${t.subdomain}  (${t.status}, ${t.staff} staff)`);
      }
      const dev = process.env.DEV_TENANT_SUBDOMAIN;
      if (dev && !rows.some((t) => t.subdomain === dev)) {
        bad(`DEV_TENANT_SUBDOMAIN is "${dev}" but no clinic has that subdomain`);
        problem(
          'localhost points at a clinic that does not exist',
          `set DEV_TENANT_SUBDOMAIN to one of: ${rows.map((t) => t.subdomain).join(', ')}`,
        );
      }
    }
  } catch (e) {
    bad(`tenants is unreadable: ${e.message}`);
  }

  await admin.end();

  /* ── 6. is the API actually running ──────────────────────────────── */
  head('6. API process');

  const port = process.env.PORT || 3000;
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(4000),
    });
    const body = await res.json();
    if (body.checks && body.checks.database === 'up') {
      ok(`API is running on :${port} and reaches the database`);
    } else {
      bad(`API is running on :${port} but reports the database as down`);
      problem('API cannot reach the database', 'restart it: npm run api:dev');
    }
  } catch {
    bad(`nothing answering on http://localhost:${port}/api/health`);
    info('Vite proxies /api to this port; with nothing there, every login is a 500.');
    problem('API not running', 'npm run api:dev');
  }

  report();
}

function report() {
  console.log(`\n${B}${'─'.repeat(64)}${X}`);
  if (problems.length === 0) {
    console.log(`\n  ${G}Everything checks out.${X}`);
    console.log(
      `  ${D}If login still fails, the error is in the API terminal, not the browser.${X}\n`,
    );
    return;
  }
  console.log(`\n  ${R}${problems.length} problem(s), in the order to fix them:${X}\n`);
  problems.forEach((p, i) => {
    console.log(`   ${i + 1}. ${p.what}`);
    console.log(`      ${B}${p.fix}${X}`);
  });
  console.log('');
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\n  ${R}doctor crashed${X}: ${e.message}\n`);
  process.exit(1);
});
