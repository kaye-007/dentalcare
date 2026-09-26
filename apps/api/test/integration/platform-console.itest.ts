import * as bcrypt from 'bcryptjs';
import { call, startApi, TestApi } from './api';
import { closePools, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * The console's price list and its platform-wide activity trail.
 *
 * Plans are what the billing run reads, so the properties that matter are the
 * ones money depends on: a retired plan cannot be given to a clinic, a code
 * cannot be taken twice, and every change lands in the audit trail with what
 * it was before. The activity feed is a read over that trail; what matters
 * there is that it names the clinic, filters honestly, and pages without
 * repeating a row.
 */

let api: TestApi;
let s: Scenario;
let adminId: string;
let token: string;

const PASSWORD = 'platform-console-password';
const CODE = `itest_${Math.random().toString(36).slice(2, 8)}`;

interface PlanListRow {
  id: string;
  code: string;
  name: string;
  price_monthly: number;
  is_active: boolean;
  clinic_count: number;
  paying_count: number;
  mrr: number;
}

interface ActivityPage {
  rows: {
    id: string;
    action: string;
    created_at: string;
    tenant_id: string | null;
    tenant_name: string | null;
    plan_name: string | null;
    metadata: Record<string, unknown>;
  }[];
  next: { before: string; beforeId: string } | null;
}

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();

  const email = `console-${Math.random().toString(36).slice(2, 8)}@nodex.test`;
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name, status)
     VALUES ($1, $2, 'Console Admin', 'active') RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 4)],
  );
  adminId = rows[0].id;

  const res = await call<{ accessToken: string }>(
    api,
    'POST',
    '/api/platform/auth/login',
    {
      body: { email, password: PASSWORD },
    },
  );
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`platform login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  token = res.body.accessToken;
});

afterAll(async () => {
  await ownerQuery('DELETE FROM audit_log WHERE actor_id = $1', [adminId]);
  await ownerQuery('DELETE FROM plans WHERE code = $1', [CODE]);
  await ownerQuery('DELETE FROM platform_admins WHERE id = $1', [adminId]);
  await destroyScenario(s);
  await api.close();
  await closePools();
});

async function allPlans(): Promise<PlanListRow[]> {
  const res = await call<PlanListRow[]>(api, 'GET', '/api/platform/plans/all', { token });
  expect(res.status).toBe(200);
  return res.body;
}

describe('the price list', () => {
  let planId: string;

  it('creates a plan that the pickers then offer', async () => {
    const res = await call<{ id: string }>(api, 'POST', '/api/platform/plans', {
      token,
      body: { code: CODE, name: 'Integration', priceMonthly: 12_300 },
    });
    expect(res.status).toBe(201);
    planId = res.body.id;

    const active = await call<{ id: string }[]>(api, 'GET', '/api/platform/plans', {
      token,
    });
    expect(active.body.map((p) => p.id)).toContain(planId);

    const row = (await allPlans()).find((p) => p.id === planId);
    expect(row).toMatchObject({
      code: CODE,
      price_monthly: 12_300,
      is_active: true,
      clinic_count: 0,
      mrr: 0,
    });
  });

  it('refuses a second plan with the same code', async () => {
    const res = await call(api, 'POST', '/api/platform/plans', {
      token,
      body: { code: CODE, name: 'Duplicate', priceMonthly: 100 },
    });
    expect(res.status).toBe(409);
  });

  it('refuses a code that could not be snapshotted cleanly', async () => {
    const res = await call(api, 'POST', '/api/platform/plans', {
      token,
      body: { code: 'Has Spaces', name: 'Bad', priceMonthly: 100 },
    });
    expect(res.status).toBe(400);
  });

  it('counts a paying clinic and its recurring revenue', async () => {
    await ownerQuery(
      "UPDATE tenants SET plan_id = $1, status = 'active', trial_ends_at = NULL WHERE id = $2",
      [planId, s.a.id],
    );
    const row = (await allPlans()).find((p) => p.id === planId);
    expect(row).toMatchObject({ clinic_count: 1, paying_count: 1, mrr: 12_300 });
    await ownerQuery('UPDATE tenants SET plan_id = NULL WHERE id = $1', [s.a.id]);
  });

  it('records a price change with what it was before', async () => {
    const res = await call(api, 'PATCH', `/api/platform/plans/${planId}`, {
      token,
      body: { priceMonthly: 15_000 },
    });
    expect(res.status).toBe(200);

    const { rows } = await ownerQuery<{
      metadata: { priceMonthly: { from: number; to: number } };
    }>(
      "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'plan.updated'",
      [planId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.priceMonthly).toEqual({ from: 12_300, to: 15_000 });
  });

  /**
   * Retiring is the only removal there is. Clinics already on the plan keep
   * it — their invoices snapshot its code — but nobody new can be put on it.
   */
  it('retires a plan so that no clinic can be put on it', async () => {
    const retire = await call(api, 'PATCH', `/api/platform/plans/${planId}`, {
      token,
      body: { isActive: false },
    });
    expect(retire.status).toBe(200);

    const active = await call<{ id: string }[]>(api, 'GET', '/api/platform/plans', {
      token,
    });
    expect(active.body.map((p) => p.id)).not.toContain(planId);
    expect((await allPlans()).find((p) => p.id === planId)?.is_active).toBe(false);

    const assign = await call(api, 'PATCH', `/api/platform/tenants/${s.a.id}/plan`, {
      token,
      body: { planId },
    });
    expect(assign.status).toBe(404);
  });

  it('refuses an update that changes nothing', async () => {
    const res = await call(api, 'PATCH', `/api/platform/plans/${planId}`, {
      token,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('requires a platform token', async () => {
    const res = await call(api, 'POST', '/api/platform/plans', {
      body: { code: 'nope', name: 'Nope', priceMonthly: 1 },
    });
    expect(res.status).toBe(401);
  });
});

describe('the platform activity trail', () => {
  beforeAll(async () => {
    // Two recorded actions against a named clinic.
    for (const status of ['suspended', 'active'] as const) {
      const res = await call(api, 'PATCH', `/api/platform/tenants/${s.b.id}/status`, {
        token,
        body: { status },
      });
      expect(res.status).toBe(200);
    }
  });

  it('names the clinic an entry is about', async () => {
    const res = await call<ActivityPage>(
      api,
      'GET',
      '/api/platform/activity?category=clinics',
      { token },
    );
    expect(res.status).toBe(200);
    const mine = res.body.rows.filter((r) => r.tenant_id === s.b.id);
    expect(mine.map((r) => r.action)).toEqual(
      expect.arrayContaining(['tenant.suspended', 'tenant.reactivated']),
    );
    expect(mine[0].tenant_name).toBeTruthy();
  });

  it('filters by category', async () => {
    const res = await call<ActivityPage>(
      api,
      'GET',
      '/api/platform/activity?category=plans',
      { token },
    );
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(res.body.rows.every((r) => r.action.startsWith('plan.'))).toBe(true);
  });

  it('pages without repeating a row', async () => {
    const first = await call<ActivityPage>(api, 'GET', '/api/platform/activity?limit=2', {
      token,
    });
    expect(first.status).toBe(200);
    expect(first.body.rows).toHaveLength(2);
    expect(first.body.next).not.toBeNull();

    const cursor = first.body.next!;
    const next = await call<ActivityPage>(
      api,
      'GET',
      `/api/platform/activity?limit=2&before=${encodeURIComponent(cursor.before)}&beforeId=${cursor.beforeId}`,
      { token },
    );
    expect(next.status).toBe(200);
    const seen = new Set(first.body.rows.map((r) => r.id));
    expect(next.body.rows.some((r) => seen.has(r.id))).toBe(false);
  });

  it('refuses a category it does not know', async () => {
    const res = await call(api, 'GET', '/api/platform/activity?category=everything', {
      token,
    });
    expect(res.status).toBe(400);
  });

  it('requires a platform token', async () => {
    const res = await call(api, 'GET', '/api/platform/activity');
    expect(res.status).toBe(401);
  });
});
