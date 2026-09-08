/**
 * Wipe ALL tenant and platform data. Schema is untouched.
 *
 * This removes every clinic, user, patient, appointment, invoice, payment,
 * expense, reminder, and platform admin. It exists so a demo environment can
 * be returned to a known-empty state before seeding.
 *
 *   npm run reset-demo
 *
 * Guarded against production by scripts/lib/guard.js. Reference data that the
 * application needs to function (subscription `plans`) is preserved unless
 * --plans is passed.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const { assertNotProduction } = require('./lib/guard');

/**
 * Order matters only for readability — TRUNCATE ... CASCADE handles the
 * foreign keys. `plans` is deliberately absent: it is configuration, not
 * demo data.
 */
const TENANT_TABLES = [
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
  'clinic_settings',
  'users',
  'tenants',
];

const PLATFORM_TABLES = ['audit_log', 'platform_admins'];

async function main() {
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

  console.log(`\n  Resetting ${host}/${dbName}`);
  console.log(
    `  Truncating ${tables.length} tables${alsoPlans ? ' (including plans)' : ''}\n`,
  );

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    await client.query('COMMIT');
    console.log('  Reset complete. Run `npm run seed` to load the demo clinic.\n');
  } catch (err) {
    await client.query('ROLLBACK');
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
