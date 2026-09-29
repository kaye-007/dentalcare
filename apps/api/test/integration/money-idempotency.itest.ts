import { randomUUID } from 'node:crypto';
import { call, login, startApi, TestApi } from './api';
import { closePools, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * A repeated click must not repeat money.
 *
 * Every route that creates or reverses money takes an Idempotency-Key: the
 * same key replays the first response, and the handler does not run again.
 * Payments and the cash drawer already did; these are the rest. Since
 * 2026-09-28 the key is required: a request without one is refused (428).
 *
 * The replay store and the handler's own transaction are two commits. Where
 * a second run would duplicate money even after the replay is lost (a
 * process dying between them), the key is also stored on the row under a
 * unique index, so the rerun is refused instead of recorded twice. Here the
 * lost replay is simulated by deleting the stored key.
 */

let api: TestApi;
let s: Scenario;
let token: string;

const key = () => `k-${randomUUID()}`;
const post = <T = Record<string, unknown>>(path: string, body: unknown, k?: string) =>
  call<T>(api, 'POST', path, {
    token,
    subdomain: s.a.subdomain,
    body,
    headers: k ? { 'Idempotency-Key': k } : undefined,
  });
/** What a crash between the two commits leaves: the replay store without the key. */
const forget = (k: string) =>
  ownerQuery('DELETE FROM idempotency_keys WHERE key = $1', [k]);
const count = async (sql: string, params: unknown[]) =>
  Number((await ownerQuery<{ n: string }>(sql, params)).rows[0]!.n);

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  token = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('creating an invoice', () => {
  const invoices = () =>
    count('SELECT count(*) AS n FROM invoices WHERE patient_id = $1', [s.a.patientId]);
  const body = () => ({
    patientId: s.a.patientId,
    items: [{ description: 'Kontroll', unitPrice: 120000, quantity: 1 }],
  });

  it('replays a repeat with the same key: one invoice', async () => {
    const before = await invoices();
    const k = key();
    const first = await post<{ id: string }>('/api/invoices', body(), k);
    const again = await post<{ id: string }>('/api/invoices', body(), k);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await invoices()).toBe(before + 1);
  });

  it('refuses the rerun that a lost replay would let through', async () => {
    const k = key();
    expect((await post('/api/invoices', body(), k)).status).toBe(201);
    const before = await invoices();
    await forget(k);
    const rerun = await post<{ code: string }>('/api/invoices', body(), k);
    expect(rerun.status).toBe(409);
    expect(rerun.body.code).toBe('invoice_already_created');
    expect(await invoices()).toBe(before);
  });

  it('refuses a request without a key (428), and records nothing', async () => {
    const before = await invoices();
    const res = await call<{ code: string }>(api, 'POST', '/api/invoices', {
      token,
      subdomain: s.a.subdomain,
      body: body(),
      idempotencyKey: null,
    });
    expect(res.status).toBe(428);
    expect(res.body.code).toBe('idempotency_key_required');
    expect(await invoices()).toBe(before);
  });

  it('refuses a key that is not one (400), and records nothing', async () => {
    const before = await invoices();
    const res = await call<{ code: string }>(api, 'POST', '/api/invoices', {
      token,
      subdomain: s.a.subdomain,
      body: body(),
      idempotencyKey: 'too short',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('idempotency_key_invalid');
    expect(await invoices()).toBe(before);
  });
});

describe('recording an expense', () => {
  const note = `idem-${randomUUID()}`;
  const expenses = () =>
    count('SELECT count(*) AS n FROM expenses WHERE note = $1', [note]);
  const body = { category: 'other', amount: 45000, note };

  it('replays a repeat with the same key: one expense', async () => {
    const k = key();
    const first = await post<{ id: string }>('/api/expenses', body, k);
    const again = await post<{ id: string }>('/api/expenses', body, k);
    expect(first.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await expenses()).toBe(1);
  });

  it('refuses the rerun that a lost replay would let through', async () => {
    const k = key();
    expect((await post('/api/expenses', body, k)).status).toBe(201);
    await forget(k);
    const rerun = await post<{ code: string }>('/api/expenses', body, k);
    expect(rerun.status).toBe(409);
    expect(rerun.body.code).toBe('expense_already_recorded');
    expect(await expenses()).toBe(2);
  });

  it('voids once, and replays the void', async () => {
    const made = await post<{ id: string }>('/api/expenses', body);
    const k = key();
    const first = await post(
      `/api/expenses/${made.body.id}/void`,
      { reason: 'Gabim' },
      k,
    );
    const again = await post(
      `/api/expenses/${made.body.id}/void`,
      { reason: 'Gabim' },
      k,
    );
    expect(first.status).toBeLessThan(300);
    expect(again.status).toBe(first.status);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    // Without the replay the void still cannot happen twice.
    await forget(k);
    const rerun = await post(
      `/api/expenses/${made.body.id}/void`,
      { reason: 'Gabim' },
      k,
    );
    expect(rerun.status).toBe(400);
  });
});

describe('a ledger adjustment', () => {
  const description = `idem-${randomUUID()}`;
  const entries = () =>
    count('SELECT count(*) AS n FROM ledger_entries WHERE description = $1', [
      description,
    ]);
  const body = { entryType: 'adjustment', amount: 2500, description };
  const path = () => `/api/patients/${s.a.patientId}/ledger/adjustments`;

  it('replays a repeat with the same key: one entry', async () => {
    const k = key();
    const first = await post(path(), body, k);
    const again = await post(path(), body, k);
    expect(first.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(await entries()).toBe(1);
  });

  it('refuses the rerun that a lost replay would let through', async () => {
    const k = key();
    expect((await post(path(), body, k)).status).toBe(201);
    await forget(k);
    const rerun = await post<{ code: string }>(path(), body, k);
    expect(rerun.status).toBe(409);
    expect(rerun.body.code).toBe('adjustment_already_recorded');
    expect(await entries()).toBe(2);
  });
});

describe('invoicing a treatment plan', () => {
  it('replays a repeat, and cannot bill the same work twice without it', async () => {
    const plan = await post<{ id: string }>(
      `/api/patients/${s.a.patientId}/treatment-plans`,
      {
        title: 'Idempotency',
      },
    );
    const item = await post<{ id: string }>(
      `/api/treatment-plans/${plan.body.id}/items`,
      {
        description: 'Mbushje',
        unitFee: 90000,
      },
    );
    await call(api, 'PATCH', `/api/treatment-plan-items/${item.body.id}`, {
      token,
      subdomain: s.a.subdomain,
      body: { status: 'completed' },
    });
    for (const status of ['proposed', 'accepted']) {
      await post(`/api/treatment-plans/${plan.body.id}/status`, { status });
    }
    const billed = () =>
      count('SELECT count(*) AS n FROM invoices WHERE treatment_plan_id = $1', [
        plan.body.id,
      ]);

    const k = key();
    const first = await post<{ id: string }>(
      `/api/treatment-plans/${plan.body.id}/invoice`,
      {},
      k,
    );
    const again = await post<{ id: string }>(
      `/api/treatment-plans/${plan.body.id}/invoice`,
      {},
      k,
    );
    expect(first.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await billed()).toBe(1);

    await forget(k);
    const rerun = await post(`/api/treatment-plans/${plan.body.id}/invoice`, {}, k);
    expect(rerun.status).toBe(400);
    expect(await billed()).toBe(1);
  });
});

/**
 * No money moves without a key (the owner's decision, 2026-09-28). Each of
 * these answers 428 before its handler runs, so before it reads the body or
 * looks up the id: the ids here name nothing. idempotency-coverage.spec.ts is
 * what keeps this list complete; this proves the refusal is real on each.
 */
describe('every route that moves money requires a key', () => {
  const none = randomUUID();
  const routes: [string, string][] = [
    ['POST', '/api/invoices'],
    ['PATCH', `/api/invoices/${none}/cancel`],
    ['POST', `/api/invoices/${none}/payments`],
    ['POST', `/api/payments/${none}/void`],
    ['POST', `/api/treatment-plans/${none}/invoice`],
    ['POST', `/api/patients/${none}/ledger/adjustments`],
    ['POST', '/api/expenses'],
    ['POST', `/api/expenses/${none}/void`],
    ['POST', `/api/staff/${none}/salary-payments`],
    ['POST', `/api/invoices/${none}/fiscal`],
    ['POST', '/api/fiscal/cash-deposits'],
    ['POST', `/api/fiscal/queue/${none}/retry`],
    ['POST', '/api/drawer/sessions'],
    ['POST', `/api/drawer/sessions/${none}/drops`],
    ['POST', `/api/drawer/sessions/${none}/payouts`],
    ['POST', `/api/drawer/sessions/${none}/float`],
    ['POST', `/api/drawer/sessions/${none}/counts`],
    ['POST', `/api/drawer/sessions/${none}/close`],
    ['POST', `/api/drawer/sessions/${none}/approve`],
    ['POST', `/api/drawer/sessions/${none}/approve-with-pin`],
    ['POST', `/api/drawer/sessions/${none}/force-close`],
    ['POST', '/api/patient-imports'],
    ['POST', '/api/whatsapp/reminders/send'],
  ];

  beforeAll(async () => {
    // The drawer routes sit behind the clinic's feature switch, a guard that
    // answers before the key is looked at.
    const on = await call(api, 'PATCH', '/api/features/cash_drawer', {
      token,
      subdomain: s.a.subdomain,
      body: { enabled: true },
    });
    expect(on.status).toBe(200);
  });

  it.each(routes)('%s %s answers 428 without a key', async (method, path) => {
    const res = await call<{ code: string }>(api, method, path, {
      token,
      subdomain: s.a.subdomain,
      body: {},
      idempotencyKey: null,
    });
    expect(res.status).toBe(428);
    expect(res.body.code).toBe('idempotency_key_required');
  });

  it('asks who is calling before it asks for a key', async () => {
    const anonymous = await call(api, 'POST', '/api/invoices', {
      subdomain: s.a.subdomain,
      body: {},
      idempotencyKey: null,
    });
    expect(anonymous.status).toBe(401);
  });
});
