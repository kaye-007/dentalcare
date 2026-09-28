/**
 * Wipe ALL tenant and platform data. Schema is untouched.
 *
 * This removes every clinic, user, patient, appointment, invoice, payment,
 * expense, reminder, and platform admin. It exists so a demo environment can
 * be returned to a known-empty state before seeding.
 *
 *   DEMO_ENV=true npm run reset-demo
 *
 * Refuses to run unless DEMO_ENV=true is set for the command, and is also
 * guarded against production hosts by scripts/lib/guard.js. Reference data that the
 * application needs to function (subscription `plans`) is preserved unless
 * --plans is passed.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const { assertNotProduction, assertDemoEnvironment } = require('./lib/guard');

/**
 * Order matters only for readability — TRUNCATE ... CASCADE handles the
 * foreign keys. `plans` is deliberately absent: it is configuration, not
 * demo data.
 */
const TENANT_TABLES = [
  // Lab work (0020) refers to patients, plan items, and the labs below.
  'lab_orders',
  // Phase 4 — clinical charting. tooth_records was here; migration 0015 drops
  // that table, so truncating it threw and no reset ever completed.
  'perio_measurements',
  'perio_tooth_findings',
  'perio_exams',
  'treatment_plan_items',
  'treatment_plans',
  'clinical_procedures',
  'tooth_conditions',
  'procedure_codes',
  // Phase 5 — billing ledger.
  'ledger_entries',
  'reminders',
  'salary_payments',
  'payments',
  'invoice_line_items',
  'invoices',
  'expenses',
  // Phase 2 — patient records.
  'patient_documents',
  'patient_medications',
  'patient_conditions',
  'patient_allergies',
  'patient_notes',
  // Phase 3 — scheduling.
  'appointment_status_events',
  'appointments',
  'staff_availability',
  'operatories',
  'treatments',
  'patients',
  // Inventory (0002). Reached by the tenants cascade anyway; listed so the
  // count printed below is the truth.
  'stock_movements',
  'inventory_items',
  // Labs and suppliers (0020), which items and lab work refer to.
  'partners',
  // Append-only audit trail. See NO_TRUNCATE_TRIGGERS_SQL below for why its
  // guard is lifted for the length of the reset.
  'clinic_audit_log',
  'clinic_settings',
  'users',
  'tenants',
];

const PLATFORM_TABLES = ['audit_log', 'platform_admins'];

/**
 * Several tables refuse TRUNCATE for every role, the owner included: the
 * clinic audit log, the patient access log, and the cash drawer's evidence
 * (events, counts, reviews, approvals). The tenants cascade reaches all of
 * them, so a reset used to fail outright on the first one it met.
 *
 * Their guards are found by name rather than listed here, so a future
 * append-only table cannot silently break the reset again. Disabling them
 * inside the transaction is the same deliberate act the integration fixtures
 * use (test/integration/fixtures.ts). ALTER TABLE is transactional in
 * Postgres: if the truncate fails, the rollback restores every trigger, so a
 * guard can never be left switched off. The runtime role has no rights over
 * these triggers, and this script refuses anything not marked as a demo.
 */
const NO_TRUNCATE_TRIGGERS_SQL = `
  SELECT tgrelid::regclass::text AS tbl, tgname AS name
    FROM pg_trigger
   WHERE NOT tgisinternal AND right(tgname, 12) = '_no_truncate'
   ORDER BY 1`;

async function main() {
  // Explicit opt-in first: DEMO_ENV=true for this command, then the
  // production and local-host checks on the connection string.
  assertDemoEnvironment({ action: 'reset' });
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }
  const { host, dbName } = assertNotProduction(process.env.DATABASE_URL, {
    overrideVar: 'ALLOW_REMOTE_RESET',
    action: 'reset',
  });

  const alsoPlans = process.argv.includes('--plans');
  const tables = alsoPlans
    ? [...TENANT_TABLES, ...PLATFORM_TABLES, 'plans']
    : [...TENANT_TABLES, ...PLATFORM_TABLES];

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    // Say exactly what is about to disappear. A demo database holds the demo
    // clinic and perhaps a few test clinics; a list of real practice names
    // here is the last chance to notice the wrong DATABASE_URL.
    const { rows: clinics } = await client.query(
      'SELECT name, subdomain FROM tenants ORDER BY created_at',
    );
    console.log(`\n  Resetting ${host}/${dbName}`);
    console.log(
      `  Removing ${clinics.length} clinic${clinics.length === 1 ? '' : 's'}` +
        (clinics.length ? ':' : ''),
    );
    for (const c of clinics) console.log(`    - ${c.name} (${c.subdomain})`);
    console.log(
      `  Truncating ${tables.length} tables${alsoPlans ? ' (including plans)' : ''}\n`,
    );

    await client.query('BEGIN');
    const { rows: guards } = await client.query(NO_TRUNCATE_TRIGGERS_SQL);
    for (const g of guards) {
      await client.query(`ALTER TABLE ${g.tbl} DISABLE TRIGGER ${g.name}`);
    }
    await client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    for (const g of guards) {
      await client.query(`ALTER TABLE ${g.tbl} ENABLE TRIGGER ${g.name}`);
    }
    await client.query('COMMIT');
    console.log('  Reset complete. Run `npm run seed` to load the demo clinic.\n');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Reset failed:', err.message);
    process.exit(1);
  });
}

module.exports = { TENANT_TABLES, PLATFORM_TABLES };
