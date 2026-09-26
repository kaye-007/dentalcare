import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { closePools, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Subscription billing and fleet usage (0016) — the vendor's own two
 * questions: is this clinic paying, and what is it consuming.
 *
 * The test that matters most here is the last one. `subscription_invoices`
 * carries what every clinic pays; a clinic connection that could read it would
 * be a cross-tenant leak of commercial data, so the grant surface is asserted
 * directly rather than inferred from a policy.
 */

let api: TestApi;
let s: Scenario;
let adminEmail: string;
let adminId: string;
let token: string;
let clinicToken: string;
let planId: string;

const PLATFORM_PASSWORD = 'platform-billing-password';
const P = (body?: unknown) => ({ token, body });

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();

  adminEmail = `billing-${Math.random().toString(36).slice(2, 8)}@nodex.test`;
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name, status)
     VALUES ($1, $2, 'Billing Admin', 'active') RETURNING id`,
    [adminEmail, await bcrypt.hash(PLATFORM_PASSWORD, 4)],
  );
  adminId = rows[0]!.id;
  token = (
    await call<{ accessToken: string }>(api, 'POST', '/api/platform/auth/login', {
      body: { email: adminEmail, password: PLATFORM_PASSWORD },
    })
  ).body.accessToken;

  clinicToken = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;

  // A paid plan, and the clinic put on it out of trial, so billing has work.
  const plan = await owner().query<{ id: string }>(
    `INSERT INTO plans (code, name, price_monthly)
     VALUES ($1, 'Billing Test Plan', 4900) RETURNING id`,
    [`billing-test-${Math.random().toString(36).slice(2, 7)}`],
  );
  planId = plan.rows[0]!.id;
  await ownerQuery(`UPDATE tenants SET plan_id = $2, trial_ends_at = NULL WHERE id = $1`, [
    s.a.id,
    planId,
  ]);
});

afterAll(async () => {
  await ownerQuery('DELETE FROM subscription_invoices WHERE tenant_id = $1', [s.a.id]);
  await ownerQuery('UPDATE tenants SET plan_id = NULL WHERE id = $1', [s.a.id]);
  await ownerQuery('DELETE FROM plans WHERE id = $1', [planId]);
  await ownerQuery('DELETE FROM platform_admins WHERE id = $1', [adminId]);
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('running the month', () => {
  it('issues one invoice per clinic, and a second run issues nothing', async () => {
    const first = await call<{ considered: number; issued: number; numbers: string[] }>(
      api, 'POST', '/api/platform/billing/run', P({}),
    );
    expect(first.status).toBe(201);
    expect(first.body.issued).toBeGreaterThanOrEqual(1);

    // The button is idempotent by constraint: pressing it twice is harmless.
    const second = await call<{ issued: number }>(api, 'POST', '/api/platform/billing/run', P({}));
    expect(second.status).toBe(201);
    expect(second.body.issued).toBe(0);

    const mine = await ownerQuery<{ n: string }>(
      'SELECT count(*) AS n FROM subscription_invoices WHERE tenant_id = $1',
      [s.a.id],
    );
    expect(Number(mine.rows[0]!.n)).toBe(1);
  });

  it('snapshots the plan and its price onto the invoice', async () => {
    const { rows } = await ownerQuery<{ amount: number; plan_name: string; status: string }>(
      'SELECT amount, plan_name, status FROM subscription_invoices WHERE tenant_id = $1',
      [s.a.id],
    );
    expect(rows[0]!.amount).toBe(4900);
    expect(rows[0]!.plan_name).toBe('Billing Test Plan');
    expect(rows[0]!.status).toBe('open');
  });
});

describe('lateness', () => {
  /**
   * The bug this pins: `date` columns arrive from node-postgres as JS Date
   * objects, and comparing one to a 'YYYY-MM-DD' string is silently false —
   * so nothing was ever overdue and the console reported a clean book while
   * clinics ran months behind. The API sends date-only values as text.
   */
  it('reports a past-due invoice as overdue, in days', async () => {
    await ownerQuery(
      `UPDATE subscription_invoices SET due_date = current_date - 5 WHERE tenant_id = $1`,
      [s.a.id],
    );
    const res = await call<{ id: string; dueDate: string; overdue: boolean; daysLate: number }[]>(
      api, 'GET', `/api/platform/billing/tenants/${s.a.id}/invoices`, P(),
    );
    const invoice = res.body[0]!;
    expect(invoice.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(invoice.overdue).toBe(true);
    expect(invoice.daysLate).toBe(5);

    const overdueOnly = await call<{ id: string }[]>(
      api, 'GET', '/api/platform/billing/invoices?overdue=true', P(),
    );
    expect(overdueOnly.body.some((i) => i.id === invoice.id)).toBe(true);

    const summary = await call<{ overdueCount: number }>(
      api, 'GET', '/api/platform/billing/summary', P(),
    );
    expect(summary.body.overdueCount).toBeGreaterThanOrEqual(1);
  });

  it('carries no time or zone on a period either', async () => {
    const res = await call<{ periodStart: string; periodEnd: string }[]>(
      api, 'GET', `/api/platform/billing/tenants/${s.a.id}/invoices`, P(),
    );
    expect(res.body[0]!.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body[0]!.periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('settling an invoice', () => {
  async function mine() {
    const res = await call<{ id: string; status: string; amount: number }[]>(
      api, 'GET', `/api/platform/billing/tenants/${s.a.id}/invoices`, P(),
    );
    return res.body[0]!;
  }

  it('records the payment, and refuses to record it twice', async () => {
    const invoice = await mine();
    const paid = await call<{ status: string; paidAmount: number }>(
      api, 'POST', `/api/platform/billing/invoices/${invoice.id}/pay`,
      P({ method: 'bank_transfer', reference: 'TXN-55512' }),
    );
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ status: 'paid', paidAmount: 4900 });

    const again = await call<{ code: string }>(
      api, 'POST', `/api/platform/billing/invoices/${invoice.id}/pay`, P({ method: 'cash' }),
    );
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('already_paid');
  });

  it('will not void money it has already taken', async () => {
    const invoice = await mine();
    const refused = await call<{ code: string }>(
      api, 'POST', `/api/platform/billing/invoices/${invoice.id}/void`,
      P({ reason: 'issued in error' }),
    );
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('already_paid');
  });

  it('leaves an audit trail naming the admin who took it', async () => {
    const { rows } = await ownerQuery<{ action: string; actor_label: string }>(
      `SELECT action, actor_label FROM audit_log
        WHERE action = 'platform.billing.paid' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]!.actor_label).toBe(adminEmail);
  });
});

describe('what the console reports', () => {
  it('summarises the fleet in money', async () => {
    const res = await call<{
      mrr: number; paidThisMonth: number; openCount: number; overdueCount: number;
      unbilledClinics: number;
    }>(api, 'GET', '/api/platform/billing/summary', P());
    expect(res.status).toBe(200);
    expect(res.body.mrr).toBeGreaterThanOrEqual(4900);
    expect(res.body.paidThisMonth).toBeGreaterThanOrEqual(4900);
    // This clinic was billed this month, so it is not waiting to be.
    expect(typeof res.body.unbilledClinics).toBe('number');
  });

  it('reports usage and storage per clinic', async () => {
    const res = await call<{
      totals: { clinics: number; patients: number; storageBytes: number };
      tenants: { tenantId: string; patients: number; storageBytes: number }[];
      storageByKind: unknown[];
      reclaimable: { bytes: number };
    }>(api, 'GET', '/api/platform/usage', P());
    expect(res.status).toBe(200);
    expect(res.body.totals.clinics).toBeGreaterThanOrEqual(1);
    const row = res.body.tenants.find((t) => t.tenantId === s.a.id)!;
    expect(row).toBeTruthy();
    expect(row.patients).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.storageByKind)).toBe(true);
    expect(typeof res.body.reclaimable.bytes).toBe('number');
  });

  it('breaks one clinic down by month and by document kind', async () => {
    const res = await call<{
      tenantId: string;
      months: { month: string; appointments: number; revenue: number }[];
      storageByKind: unknown[];
    }>(api, 'GET', `/api/platform/usage/${s.a.id}`, P());
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(s.a.id);
    expect(res.body.months).toHaveLength(6);
  });
});

describe('the boundary around the vendor’s books', () => {
  it('refuses a clinic token everywhere in the platform console', async () => {
    for (const path of ['/api/platform/billing/summary', '/api/platform/usage']) {
      const res = await call(api, 'GET', path, { token: clinicToken, subdomain: s.a.subdomain });
      expect(res.status).toBe(401);
    }
  });

  it('refuses an anonymous caller', async () => {
    expect((await call(api, 'GET', '/api/platform/billing/summary', {})).status).toBe(401);
  });

  /**
   * The structural guarantee, not the policy one. app_user holds no privilege
   * on this table at all, so a clinic connection cannot read what every other
   * clinic pays even if a policy were mistakenly added later.
   */
  it('grants the clinic role no access to subscription_invoices whatsoever', async () => {
    const { rows } = await ownerQuery<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'subscription_invoices' AND grantee = $1`,
      [process.env.APP_DB_USER || 'app_user'],
    );
    expect(rows).toHaveLength(0);
  });
});
