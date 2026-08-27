/* eslint-disable no-console */
/**
 * Reproduce the login database path exactly as the API performs it, as the
 * application role, printing the raw Postgres error rather than the 500 the
 * HTTP layer turns it into.
 *
 *   node scripts/diagnose-login.js [email]
 *
 * Login touches four things that can each fail identically from the browser:
 * the app role's ability to connect, resolve_tenant, the RLS GUC, and the
 * users/tenants join. This walks them in order and stops at the first one
 * that breaks.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('pg');

const EMAIL = process.argv[2] || 'demo@dentx.app';
const SUB = process.env.DEV_TENANT_SUBDOMAIN || 'demo';

const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad = (m, e) => {
  console.error(`  \x1b[31mFAILED\x1b[0m ${m}`);
  if (e) {
    console.error(`         message : ${e.message}`);
    if (e.code) console.error(`         code    : ${e.code}`);
    if (e.detail) console.error(`         detail  : ${e.detail}`);
    if (e.hint) console.error(`         hint    : ${e.hint}`);
    if (e.where) console.error(`         where   : ${e.where}`);
  }
  process.exit(1);
};

const SELECT = `
  SELECT u.id, u.tenant_id, u.email, u.password_hash, u.full_name, u.role,
         u.status AS user_status,
         t.status AS tenant_status,
         t.name   AS clinic_name,
         t.subdomain AS subdomain
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id`;

async function main() {
  console.log('\n\x1b[1mDentalCare — login path diagnosis\x1b[0m\n');

  const url = process.env.APP_DATABASE_URL;
  if (!url) bad('APP_DATABASE_URL is not set in .env');
  console.log(`  role    ${new URL(url).username}   db ${new URL(url).pathname.slice(1)}\n`);

  /* 1. can the application role connect at all */
  const c = new Client({ connectionString: url });
  try { await c.connect(); ok('connected as the application role'); }
  catch (e) { bad('the application role cannot connect — password drift, or Postgres is down', e); }

  /* 2. resolve_tenant — runs BEFORE any tenant context exists */
  let tenantId;
  try {
    const r = await c.query('SELECT id, status FROM resolve_tenant($1)', [SUB]);
    if (r.rowCount === 0) bad(`resolve_tenant('${SUB}') returned no rows — no clinic with that subdomain`);
    tenantId = r.rows[0].id;
    ok(`resolve_tenant('${SUB}') -> ${tenantId} (${r.rows[0].status})`);
  } catch (e) { bad('resolve_tenant failed — EXECUTE grant missing, or the function does not exist', e); }

  /* 3. the RLS context, set transaction-locally exactly as withTenant does */
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    ok('app.current_tenant_id set');
  } catch (e) { bad('could not set the tenant GUC', e); }

  /* 4. the actual login lookup */
  try {
    const r = await c.query(`${SELECT} WHERE lower(u.email) = lower($1) LIMIT 1`, [EMAIL]);
    if (r.rowCount === 0) {
      console.log(`  \x1b[33mwarn\x1b[0m  the query ran fine but matched no user for "${EMAIL}"`);
      const all = await c.query('SELECT email, role, status FROM users ORDER BY email');
      console.log(`\n  users visible in this tenant (${all.rowCount}):`);
      all.rows.forEach((u) => console.log(`    ${u.email}  ${u.role}  ${u.status}`));
      console.log('\n  -> not a 500. Wrong email, or the seed used different addresses.\n');
    } else {
      const u = r.rows[0];
      ok(`found ${u.email}  role=${u.role}  user_status=${u.user_status}  tenant_status=${u.tenant_status}`);
      ok(`password_hash present: ${u.password_hash ? 'yes (' + u.password_hash.slice(0, 4) + '…)' : 'NO — this would break login'}`);
      console.log('\n  The database path is healthy. A 500 at /api/auth/login is therefore');
      console.log('  in application code, not in SQL — check the API terminal stack trace.\n');
    }
  } catch (e) {
    bad('the login SELECT failed — this is what the browser sees as 500', e);
  }

  await c.query('ROLLBACK');
  await c.end();
}

main().catch((e) => bad('unexpected', e));
