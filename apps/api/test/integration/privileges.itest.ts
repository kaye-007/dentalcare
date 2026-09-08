import { asTenant, closePools, errorCodeOf, owner, ownerQuery } from './db';
import { createBilling, createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * The privileges the runtime role does NOT hold.
 *
 * Every one of these was verified by hand once, in a psql session, and then
 * lived on as a claim in a migration comment. A privilege that is supposed to
 * be absent is exactly the kind that comes back unnoticed: nothing fails when
 * it returns, because the application never issues those statements. The only
 * symptom of losing the boundary is that it is gone.
 *
 * `dev-setup` proved that concretely — its blanket
 * `GRANT ... ON ALL TABLES IN SCHEMA public` handed back DELETE on payments
 * and UPDATE on ledger_entries on every run, so 0018's money immutability was
 * absent from every local database that had run it.
 *
 * 42501 is insufficient_privilege throughout: the code, not the message,
 * because the message is prose a minor version may reword.
 */

const DENIED = '42501';

let s: Scenario;
let billing: Awaited<ReturnType<typeof createBilling>>;

beforeAll(async () => {
  s = await createScenario();
  billing = await createBilling(s.a);
});

afterAll(async () => {
  await destroyScenario(s);
  await closePools();
});

describe('a clinic cannot rewrite its own commercial state (B1)', () => {
  /**
   * RLS pins the role to its own tenants row, which is correct and was never
   * the problem. The problem is that its own row is the one saying whether it
   * is suspended, which plan it is on, and when the trial ends.
   */
  it.each([
    ['status', "status = 'active'"],
    ['plan_id', 'plan_id = NULL'],
    ['trial_ends_at', "trial_ends_at = now() + interval '10 years'"],
    ['subdomain', "subdomain = 'hijacked'"],
  ])('cannot UPDATE tenants.%s', async (_column, assignment) => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(`UPDATE tenants SET ${assignment} WHERE id = $1`, [s.a.id]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  it('cannot DELETE its own tenants row', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) => c.query('DELETE FROM tenants WHERE id = $1', [s.a.id])),
    );

    expect(code).toBe(DENIED);
  });

  /**
   * The deliberate exception. `tenants.name` is the clinic's own display name,
   * edited from Settings by the doctor; it is not commercial state, it merely
   * shares a table with it. 0021 revokes UPDATE wholesale and grants back
   * exactly these columns, the same shape 0018 used for payments.
   */
  it('CAN rename itself, which is what Settings does', async () => {
    await asTenant(s.a.id, (c) =>
      c.query('UPDATE tenants SET name = $1, updated_at = now() WHERE id = $2', [
        'Renamed From Settings',
        s.a.id,
      ]),
    );

    const { rows } = await ownerQuery<{ name: string; status: string }>(
      'SELECT name, status FROM tenants WHERE id = $1',
      [s.a.id],
    );
    expect(rows[0].name).toBe('Renamed From Settings');
    expect(rows[0].status).toBe('active');
  });

  it.each([
    ['INSERT', "INSERT INTO plans (code, name, price_monthly) VALUES ('x','X',0)"],
    ['UPDATE', 'UPDATE plans SET price_monthly = 0'],
    ['DELETE', 'DELETE FROM plans'],
  ])('cannot %s the price list', async (_verb, sql) => {
    const code = await errorCodeOf(asTenant(s.a.id, (c) => c.query(sql)));

    expect(code).toBe(DENIED);
  });

  /**
   * The migration ledger. Reading it tells an attacker exactly which schema
   * this deployment is on; editing it makes a migration re-runnable or
   * skippable.
   */
  it.each([
    ['SELECT', 'SELECT * FROM pgmigrations'],
    ['INSERT', "INSERT INTO pgmigrations (name, run_on) VALUES ('fake', now())"],
    ['DELETE', 'DELETE FROM pgmigrations'],
  ])('cannot %s pgmigrations', async (_verb, sql) => {
    const code = await errorCodeOf(asTenant(s.a.id, (c) => c.query(sql)));

    expect(code).toBe(DENIED);
  });
});

describe('the platform tables are out of reach', () => {
  it.each([
    ['platform_admins', 'SELECT * FROM platform_admins'],
    ['audit_log', 'SELECT * FROM audit_log'],
  ])('cannot read %s', async (_table, sql) => {
    const code = await errorCodeOf(asTenant(s.a.id, (c) => c.query(sql)));

    expect(code).toBe(DENIED);
  });
});

describe('money is immutable', () => {
  /**
   * Reception must be able to fix a mistake and must not be able to make one
   * disappear. A payment is reversed by voiding it — a time, a person and a
   * reason — never by editing or removing it.
   */
  it('a payment cannot be deleted', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('DELETE FROM payments WHERE id = $1', [billing.paymentId]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  it.each([
    ['amount', 'amount = 1'],
    ['method', "method = 'card'"],
    ['paid_at', 'paid_at = now()'],
  ])('a payment’s %s cannot be changed', async (_column, assignment) => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(`UPDATE payments SET ${assignment} WHERE id = $1`, [billing.paymentId]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  /** The column-level grant that makes the void workflow possible. */
  it('a payment CAN be voided, which is the supported reversal', async () => {
    await asTenant(s.a.id, (c) =>
      c.query(
        `UPDATE payments
            SET voided_at = now(), voided_by = $1, void_reason = $2
          WHERE id = $3`,
        [s.a.adminId, 'Taken twice by mistake', billing.paymentId],
      ),
    );

    const { rows } = await ownerQuery<{ voided_at: Date | null; amount: number }>(
      'SELECT voided_at, amount FROM payments WHERE id = $1',
      [billing.paymentId],
    );
    expect(rows[0].voided_at).not.toBeNull();
    // The void records the reversal; it does not alter the original figure.
    expect(rows[0].amount).toBe(1000);
  });

  it('an invoice cannot be deleted', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('DELETE FROM invoices WHERE id = $1', [billing.invoiceId]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  it('an expense cannot be deleted', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('DELETE FROM expenses WHERE id = $1', [billing.expenseId]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  it('an expense’s amount cannot be changed', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('UPDATE expenses SET amount = 1 WHERE id = $1', [billing.expenseId]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  /** 0016 called the ledger append-only in a comment; 0018 made it true. */
  it('a ledger entry cannot be updated', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('UPDATE ledger_entries SET amount = 1 WHERE id = $1', [
          billing.ledgerEntryId,
        ]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  it('a ledger entry cannot be deleted', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('DELETE FROM ledger_entries WHERE id = $1', [billing.ledgerEntryId]),
      ),
    );

    expect(code).toBe(DENIED);
  });
});

describe('the clinic audit log is append-only', () => {
  let entryId: string;

  beforeAll(async () => {
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO clinic_audit_log
         (tenant_id, actor_user_id, actor_label, actor_role, action,
          entity_type, entity_id, summary)
       VALUES ($1, $2, 'Admin A', 'admin', 'payment.recorded',
               'payments', $3, 'Recorded a payment')
       RETURNING id`,
      [s.a.id, s.a.adminId, billing.paymentId],
    );
    entryId = rows[0].id;
  });

  it('can be written to', async () => {
    await asTenant(s.a.id, (c) =>
      c.query(
        `INSERT INTO clinic_audit_log
           (tenant_id, actor_user_id, actor_label, actor_role, action,
            entity_type, summary)
         VALUES ($1, $2, 'Admin A', 'admin', 'patient.created',
                 'patients', 'Created a patient')`,
        [s.a.id, s.a.adminId],
      ),
    );

    const { rows } = await ownerQuery<{ n: string }>(
      'SELECT count(*) AS n FROM clinic_audit_log WHERE tenant_id = $1',
      [s.a.id],
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(2);
  });

  it('cannot be rewritten', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('UPDATE clinic_audit_log SET summary = $1 WHERE id = $2', [
          'Something else entirely',
          entryId,
        ]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  it('cannot be erased', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('DELETE FROM clinic_audit_log WHERE id = $1', [entryId]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  /**
   * REVOKE alone would let a future migration hand the privilege back, so the
   * table also carries a trigger that raises. Triggers fire for the owner too
   * — which is what this checks, using the connection that owns the table.
   */
  it('cannot be rewritten even by the owner role', async () => {
    const code = await errorCodeOf(
      owner().query('UPDATE clinic_audit_log SET summary = $1 WHERE id = $2', [
        'Rewritten by the owner',
        entryId,
      ]),
    );

    expect(code).toBe(DENIED);
  });

  it('cannot be truncated even by the owner role', async () => {
    const code = await errorCodeOf(owner().query('TRUNCATE clinic_audit_log'));

    expect(code).toBe(DENIED);
  });
});
