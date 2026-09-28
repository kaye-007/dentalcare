import { call, login, startApi, TestApi } from './api';
import { asTenant, closePools, owner } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * A day is the clinic's day.
 *
 * Postgres answers CURRENT_DATE on the server's clock, which for a hosted
 * database is UTC. Between midnight and 01:00 or 02:00 in Tirana that is
 * still yesterday, so an invoice written at 00:30 carried yesterday's date,
 * while its fiscal registration, dated on Tirana's clock, carried today's.
 *
 * This suite does not wait for midnight. It gives the clinic a time zone whose
 * date differs from the server's right now (UTC+14 or UTC−11: at any moment
 * one of them does) and requires every "today" the API writes to be the
 * clinic's.
 */

let api: TestApi;
let s: Scenario;
let token: string;
let zone: string;
let clinicToday: string;
let serverToday: string;

const as = <T = Record<string, unknown>>(method: string, path: string, body?: unknown) =>
  call<T>(api, method, path, { token, subdomain: s.a.subdomain, body });

const dateOf = async (sql: string, id: string) =>
  (await owner().query<{ d: string }>(sql, [id])).rows[0]?.d;

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  token = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;

  const { rows } = await owner().query<{ zone: string; clinic: string; server: string }>(
    `SELECT z AS zone, (now() AT TIME ZONE z)::date::text AS clinic,
            CURRENT_DATE::text AS server
       FROM unnest(ARRAY['Pacific/Kiritimati', 'Pacific/Pago_Pago']) AS z
      WHERE (now() AT TIME ZONE z)::date <> CURRENT_DATE
      LIMIT 1`,
  );
  ({ zone, clinic: clinicToday, server: serverToday } = rows[0]!);
  await owner().query(
    `INSERT INTO clinic_settings (tenant_id, timezone) VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET timezone = EXCLUDED.timezone`,
    [s.a.id, zone],
  );
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe("the clinic's day", () => {
  it('is set up so the two clocks disagree', () => {
    expect(clinicToday).not.toBe(serverToday);
  });

  it("is what the database calls today inside the clinic's transaction", async () => {
    const d = await asTenant(s.a.id, async (c) => {
      const { rows } = await c.query<{ d: string }>('SELECT clinic_today()::text AS d');
      return rows[0]!.d;
    });
    expect(d).toBe(clinicToday);
  });

  it('dates an invoice and its ledger charge', async () => {
    const res = await as<{ id: string }>('POST', '/api/invoices', {
      patientId: s.a.patientId,
      items: [{ description: 'Kontroll', unitPrice: 150000, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    const id = res.body.id;
    expect(
      await dateOf('SELECT issued_at::text AS d FROM invoices WHERE id = $1', id),
    ).toBe(clinicToday);
    expect(
      await dateOf(
        `SELECT occurred_on::text AS d FROM ledger_entries
          WHERE invoice_id = $1 AND entry_type = 'charge'`,
        id,
      ),
    ).toBe(clinicToday);
  });

  it('counts an invoice issued today as zero days outstanding', async () => {
    const res = await as<{ invoices: { invoiceId: string; daysOutstanding: number }[] }>(
      'GET',
      '/api/billing/receivables',
    );
    expect(res.status).toBe(200);
    expect(res.body.invoices.length).toBeGreaterThan(0);
    for (const r of res.body.invoices) expect(r.daysOutstanding).toBe(0);
  });

  it('dates an invoice made from a treatment plan, and its due date', async () => {
    const plan = await as<{ id: string }>(
      'POST',
      `/api/patients/${s.a.patientId}/treatment-plans`,
      { title: 'Kurorë' },
    );
    expect(plan.status).toBe(201);
    const item = await as<{ id: string }>(
      'POST',
      `/api/treatment-plans/${plan.body.id}/items`,
      { description: 'Kurorë zirkoni', unitFee: 250000 },
    );
    expect(item.status).toBe(201);
    const itemId = item.body.id;
    expect(
      (await as('PATCH', `/api/treatment-plan-items/${itemId}`, { status: 'completed' }))
        .status,
    ).toBe(200);
    for (const status of ['proposed', 'accepted']) {
      const t = await as('POST', `/api/treatment-plans/${plan.body.id}/status`, {
        status,
      });
      expect(t.status).toBe(201);
    }
    const inv = await as<{ id: string }>(
      'POST',
      `/api/treatment-plans/${plan.body.id}/invoice`,
      {},
    );
    expect(inv.status).toBe(201);
    const { rows } = await owner().query<{
      issued: string;
      due_gap: number;
      charge: string;
    }>(
      `SELECT i.issued_at::text AS issued, (i.due_on - i.issued_at) AS due_gap,
              (SELECT occurred_on::text FROM ledger_entries
                WHERE invoice_id = i.id AND entry_type = 'charge') AS charge
         FROM invoices i WHERE i.id = $1`,
      [inv.body.id],
    );
    const terms = await owner().query<{ days: number }>(
      'SELECT coalesce(payment_terms_days, 0) AS days FROM clinic_settings WHERE tenant_id = $1',
      [s.a.id],
    );
    expect(rows[0]).toEqual({
      issued: clinicToday,
      due_gap: terms.rows[0]!.days,
      charge: clinicToday,
    });
  });

  it('dates an expense', async () => {
    const res = await as<{ id: string }>('POST', '/api/expenses', {
      category: 'other',
      amount: 50000,
    });
    expect(res.status).toBe(201);
    expect(
      await dateOf(
        'SELECT expense_date::text AS d FROM expenses WHERE id = $1',
        res.body.id,
      ),
    ).toBe(clinicToday);
  });

  it('dates a procedure logged without a date', async () => {
    const res = await as<{ id: string }>(
      'POST',
      `/api/patients/${s.a.patientId}/procedures`,
      { description: 'Mbushje kompoziti', status: 'completed', tooth: 36 },
    );
    expect(res.status).toBe(201);
    expect(
      await dateOf(
        'SELECT performed_on::text AS d FROM clinical_procedures WHERE id = $1',
        res.body.id,
      ),
    ).toBe(clinicToday);
  });

  it('dates a perio exam', async () => {
    const res = await as<{ id: string }>(
      'POST',
      `/api/patients/${s.a.patientId}/perio-exams`,
      {},
    );
    expect(res.status).toBe(201);
    expect(
      await dateOf(
        'SELECT examined_on::text AS d FROM perio_exams WHERE id = $1',
        res.body.id,
      ),
    ).toBe(clinicToday);
  });

  it('dates a salary payment', async () => {
    const res = await as<{ id: string }>(
      'POST',
      `/api/staff/${s.a.adminId}/salary-payments`,
      { amount: 100000 },
    );
    expect(res.status).toBe(201);
    expect(
      await dateOf(
        'SELECT paid_on::text AS d FROM salary_payments WHERE id = $1',
        res.body.id,
      ),
    ).toBe(clinicToday);
  });

  it('dates a ledger adjustment', async () => {
    const res = await as<{ id: string }>(
      'POST',
      `/api/patients/${s.a.patientId}/ledger/adjustments`,
      { entryType: 'adjustment', amount: 1000, description: 'Korrigjim' },
    );
    expect(res.status).toBe(201);
    const { rows } = await owner().query<{ d: string }>(
      `SELECT occurred_on::text AS d FROM ledger_entries
        WHERE patient_id = $1 AND description = 'Korrigjim'`,
      [s.a.patientId],
    );
    expect(rows.map((r) => r.d)).toEqual([clinicToday]);
  });

  it('dates a stock lot received without a date', async () => {
    const res = await as<{ id: string }>('POST', '/api/inventory', {
      name: 'Kompozit A2',
      unit: 'shiringë',
      quantity: 4,
      trackLots: true,
      lotNumber: 'L-001',
    });
    expect(res.status).toBe(201);
    expect(
      await dateOf(
        'SELECT received_on::text AS d FROM inventory_lots WHERE item_id = $1',
        res.body.id,
      ),
    ).toBe(clinicToday);
  });
});
