import { call, login, startApi, TestApi } from './api';
import { asTenant, closePools, errorCodeOf, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Money after migration 0006: minor units, one currency per clinic, and a
 * ledger that follows an invoice when it is cancelled.
 */

const LOCKED = '55000';

let api: TestApi;
let s: Scenario;
let token: string;

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

const asAdmin = (body?: unknown) => ({ subdomain: s.a.subdomain, token, body });

async function invoice(unitPrice: number): Promise<{ id: string; total: number }> {
  const res = await call<{ id: string; total: number }>(
    api,
    'POST',
    '/api/invoices',
    asAdmin({
      patientId: s.a.patientId,
      items: [{ description: 'Composite filling', quantity: 1, unitPrice }],
    }),
  );
  expect(res.status).toBe(201);
  return res.body;
}

async function balance(): Promise<number> {
  const res = await call<{ balance: number }>(
    api,
    'GET',
    `/api/patients/${s.a.patientId}/ledger`,
    asAdmin(),
  );
  expect(res.status).toBe(200);
  return res.body.balance;
}

describe('minor units', () => {
  it('stores and returns cents: a €37.50 line is 3750, exactly', async () => {
    const created = await invoice(3750);
    expect(created.total).toBe(3750);
  });

  it('prints the clinic currency in the activity trail, not a bare number', async () => {
    const created = await invoice(1250);
    const { rows } = await ownerQuery<{ summary: string }>(
      `SELECT summary FROM clinic_audit_log WHERE entity_id = $1 AND action = 'invoice.created'`,
      [created.id],
    );
    expect(rows[0]?.summary).toContain('€12.50');
  });
});

describe('one currency per clinic', () => {
  beforeAll(async () => {
    // Clinic B has recorded no money yet, so it may still choose its currency.
    await owner().query(
      `INSERT INTO clinic_settings (tenant_id, currency) VALUES ($1, 'ALL')
       ON CONFLICT (tenant_id) DO UPDATE SET currency = 'ALL'`,
      [s.b.id],
    );
  });

  it('stamps every new invoice with the clinic currency, whatever the caller sends', async () => {
    const { rows } = await asTenant(s.b.id, (c) =>
      c.query<{ currency: string }>(
        `INSERT INTO invoices (tenant_id, patient_id, seq, invoice_number, total, subtotal, currency)
         VALUES ($1, $2, 1, 'INV-B-1', 500000, 500000, 'EUR')
         RETURNING currency`,
        [s.b.id, s.b.patientId],
      ),
    );
    expect(rows[0]?.currency).toBe('ALL');
  });

  it('refuses to change the currency of a recorded amount', async () => {
    const code = await errorCodeOf(
      asTenant(s.b.id, (c) =>
        c.query(`UPDATE invoices SET currency = 'EUR' WHERE invoice_number = 'INV-B-1'`),
      ),
    );
    expect(code).toBe(LOCKED);
  });

  it('refuses to change the clinic currency once money exists', async () => {
    const code = await errorCodeOf(
      asTenant(s.b.id, (c) =>
        c.query(`UPDATE clinic_settings SET currency = 'EUR' WHERE tenant_id = $1`, [s.b.id]),
      ),
    );
    expect(code).toBe(LOCKED);
  });

  it('answers 409 with the reason when Settings tries it', async () => {
    const res = await call<{ message: string }>(
      api,
      'PATCH',
      '/api/settings',
      asAdmin({ currency: 'USD' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/currency cannot change/);
  });

  it('tells the signed-in app which currency amounts are in', async () => {
    const res = await call<{ currency: string }>(api, 'GET', '/api/auth/me', asAdmin());
    expect(res.body.currency).toBe('EUR');
  });
});

describe('cancelling an invoice', () => {
  /**
   * This used to fail with a 500 (the cancellation broke a CHECK constraint)
   * and, had it succeeded, would have left the charge on the patient's
   * account for a bill that no longer existed.
   */
  it('succeeds, and takes its charge back off the patient ledger', async () => {
    const before = await balance();
    const created = await invoice(5000);
    expect(await balance()).toBe(before + 5000);

    const cancelled = await call<{ status: string }>(
      api,
      'PATCH',
      `/api/invoices/${created.id}/cancel`,
      asAdmin(),
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');

    expect(await balance()).toBe(before);
  });
});
