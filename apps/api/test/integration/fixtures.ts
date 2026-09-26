import * as bcrypt from 'bcryptjs';
import { owner } from './db';

/**
 * The two-clinic scenario every isolation test is written against.
 *
 *   Tenant A  avicena   admin + patient PA
 *   Tenant B  elezi     admin + patient PB
 *
 * Built with the owner connection, because creating two clinics is by
 * definition a cross-tenant act and app_user is — correctly — incapable of
 * it. Everything the tests then ASSERT goes through app_user.
 *
 * Subdomains are suffixed per run so a failed run cannot poison the next one
 * with half-built rows, and so this is safe against a database someone is
 * also using by hand.
 */

export interface TenantFixture {
  id: string;
  subdomain: string;
  adminId: string;
  adminEmail: string;
  patientId: string;
  patientLastName: string;
}

export interface Scenario {
  a: TenantFixture;
  b: TenantFixture;
  password: string;
}

/** Shared across the suite so the bcrypt cost is paid once, not per test. */
const PASSWORD = 'integration-test-password';
let passwordHash: string | undefined;

async function hash(): Promise<string> {
  // Cost 4: these are throwaway fixtures and bcrypt at the production cost
  // would dominate the runtime of the whole suite.
  passwordHash ??= await bcrypt.hash(PASSWORD, 4);
  return passwordHash;
}

function unique(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function createTenant(label: string, suffix: string): Promise<TenantFixture> {
  const subdomain = `${label}-${suffix}`;
  const adminEmail = `admin@${subdomain}.test`;
  const patientLastName = `Patient-${label.toUpperCase()}-${suffix}`;

  const tenant = await owner().query<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, status)
     VALUES ($1, $2, 'active') RETURNING id`,
    [`Clinic ${label}`, subdomain],
  );
  const id = tenant.rows[0].id;

  const admin = await owner().query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
     VALUES ($1, $2, $3, $4, 'admin', 'active') RETURNING id`,
    [id, adminEmail, await hash(), `Admin ${label}`],
  );

  const patient = await owner().query<{ id: string }>(
    `INSERT INTO patients (tenant_id, first_name, last_name, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [id, 'Test', patientLastName],
  );

  return {
    id,
    subdomain,
    adminId: admin.rows[0].id,
    adminEmail,
    patientId: patient.rows[0].id,
    patientLastName,
  };
}

export async function createScenario(): Promise<Scenario> {
  const suffix = unique();
  return {
    a: await createTenant('avicena', suffix),
    b: await createTenant('elezi', suffix),
    password: PASSWORD,
  };
}

/**
 * Remove a scenario.
 *
 * `tenants` cascades to everything that references it, so one delete per
 * clinic ought to be the whole cleanup. It is not, and the reason is worth
 * writing down: `clinic_audit_log` cascades from `tenants` too, and its
 * append-only trigger raises on DELETE for every role including the table
 * owner. So a clinic that has recorded a single action cannot be deleted by
 * anyone — the cascade is refused and the whole statement rolls back.
 *
 * That is the trigger doing exactly what 0018 designed it to do. It also
 * means 0018's own claim that "a clinic can still be removed wholesale from
 * the admin plane" is not true; nothing in the platform console deletes a
 * tenant (it suspends and archives), so no shipped feature depends on it.
 *
 * Dropping the trigger for the length of one statement is precisely the
 * "deliberate, visible act" the migration says should be required. A test
 * fixture is allowed to be deliberate; application code is not, and cannot —
 * app_user has no rights over the trigger.
 */
const APPEND_ONLY: readonly [string, string][] = [
  ['clinic_audit_log', 'clinic_audit_log_no_rewrite'],
  ['patient_access_log', 'patient_access_log_no_rewrite'],
  // The cash drawer's evidence (0014), and the session rows that name it.
  ['drawer_events', 'drawer_events_no_rewrite'],
  ['drawer_counts', 'drawer_counts_no_rewrite'],
  ['drawer_session_reviews', 'drawer_session_reviews_no_rewrite'],
  ['manager_approvals', 'manager_approvals_no_rewrite'],
  ['drawer_sessions', 'drawer_sessions_no_delete'],
];

export async function destroyScenario(scenario: Scenario): Promise<void> {
  const ids = [scenario.a.id, scenario.b.id];
  const client = await owner().connect();
  try {
    await client.query('BEGIN');
    // patient_access_log (0004) is append-only the same way, and a clinic
    // whose records were opened once has rows in it.
    for (const [table, trigger] of APPEND_ONLY) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
    await client.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [ids]);
    for (const [table, trigger] of APPEND_ONLY) {
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** An invoice with a payment and a ledger entry, for the money-immutability tests. */
export async function createBilling(tenant: TenantFixture): Promise<{
  invoiceId: string;
  paymentId: string;
  expenseId: string;
  ledgerEntryId: string;
}> {
  const seq = Math.floor(Math.random() * 1_000_000);

  const invoice = await owner().query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, patient_id, seq, invoice_number, total, subtotal, status)
     VALUES ($1, $2, $3, $4, 1000, 1000, 'unpaid') RETURNING id`,
    [tenant.id, tenant.patientId, seq, `INV-${seq}`],
  );

  const payment = await owner().query<{ id: string }>(
    `INSERT INTO payments (tenant_id, invoice_id, amount, method)
     VALUES ($1, $2, 1000, 'cash') RETURNING id`,
    [tenant.id, invoice.rows[0].id],
  );

  const expense = await owner().query<{ id: string }>(
    `INSERT INTO expenses (tenant_id, category, amount)
     VALUES ($1, 'materials', 500) RETURNING id`,
    [tenant.id],
  );

  const ledger = await owner().query<{ id: string }>(
    `INSERT INTO ledger_entries
       (tenant_id, patient_id, invoice_id, payment_id, entry_type, amount, description)
     VALUES ($1, $2, $3, $4, 'payment', 1000, 'Integration fixture')
     RETURNING id`,
    [tenant.id, tenant.patientId, invoice.rows[0].id, payment.rows[0].id],
  );

  return {
    invoiceId: invoice.rows[0].id,
    paymentId: payment.rows[0].id,
    expenseId: expense.rows[0].id,
    ledgerEntryId: ledger.rows[0].id,
  };
}

/** An operatory, so the double-booking tests have a chair to compete for. */
export async function createOperatory(tenant: TenantFixture): Promise<string> {
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO operatories (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenant.id, `Room ${unique()}`],
  );
  return rows[0].id;
}
