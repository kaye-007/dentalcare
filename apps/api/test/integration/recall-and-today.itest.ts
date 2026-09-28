import { call, login, startApi, TestApi } from './api';
import { closePools, owner } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * The recall list (who is due back, with nothing booked) and the owner's
 * "today" figures, both derived from rows the clinic already writes.
 */

let api: TestApi;
let s: Scenario;
let token: string;
const ids: Record<string, string> = {};

const get = async <T>(path: string) =>
  (await call<T>(api, 'GET', path, { token, subdomain: s.a.subdomain })).body;

async function patient(first: string, status = 'active') {
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO patients (tenant_id, first_name, last_name, status)
     VALUES ($1,$2,'Recall',$3) RETURNING id`,
    [s.a.id, first, status],
  );
  return rows[0]!.id;
}
async function visit(patientId: string, daysFromNow: number, status: string) {
  await owner().query(
    `INSERT INTO appointments
       (tenant_id, patient_id, staff_id, reason, status, starts_at, ends_at, completed_at)
     VALUES ($1,$2,$3,'Kontroll periodik',$4,
             now() + make_interval(days => $5), now() + make_interval(days => $5, mins => 30),
             CASE WHEN $4 = 'completed' THEN now() + make_interval(days => $5, mins => 30) END)`,
    [s.a.id, patientId, s.a.adminId, status, daysFromNow],
  );
}

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  token = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  // Seen seven months ago, nothing since: due at 6 months, not at 12.
  ids.due = await patient('Due');
  await visit(ids.due, -213, 'completed');
  // Same, but already booked for next week: off the list.
  ids.booked = await patient('Booked');
  await visit(ids.booked, -213, 'completed');
  await visit(ids.booked, 7, 'scheduled');
  // Seen last month: not due.
  ids.recent = await patient('Recent');
  await visit(ids.recent, -30, 'completed');
  // A no-show seven months ago is not a visit.
  ids.noshow = await patient('NoShow');
  await visit(ids.noshow, -213, 'no_show');
  // Only active patients are called back.
  ids.inactive = await patient('Inactive', 'inactive');
  await visit(ids.inactive, -213, 'completed');
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

interface Recall {
  months: number;
  items: { id: string; lastReason: string | null }[];
}

describe('recall', () => {
  it('lists patients whose last visit is past the interval, with nothing booked', async () => {
    const r = await get<Recall>('/api/patients/recall?months=6');
    expect(r.months).toBe(6);
    expect(r.items.map((i) => i.id)).toEqual([ids.due]);
    expect(r.items[0]!.lastReason).toBe('Kontroll periodik');
  });

  it('respects a longer interval', async () => {
    expect((await get<Recall>('/api/patients/recall?months=12')).items).toEqual([]);
  });

  it('falls back to six months for an interval it does not offer', async () => {
    expect((await get<Recall>('/api/patients/recall?months=7')).months).toBe(6);
  });
});

describe("the owner's today", () => {
  it("counts today's payments, on the clinic's clock", async () => {
    const inv = await call<{ id: string }>(api, 'POST', '/api/invoices', {
      token,
      subdomain: s.a.subdomain,
      body: {
        patientId: ids.due,
        items: [{ description: 'Konsultë', quantity: 1, unitPrice: 150000 }],
      },
    });
    expect(inv.status).toBe(201);
    const pay = await call(api, 'POST', `/api/invoices/${inv.body.id}/payments`, {
      token,
      subdomain: s.a.subdomain,
      body: { amount: 150000, method: 'card' },
      headers: { 'Idempotency-Key': `today-${Date.now()}` },
    });
    expect([200, 201]).toContain(pay.status);

    const today = await get<{
      period: string;
      totalCollected: number;
      totalInvoiced: number;
    }>('/api/finance/summary?period=today');
    expect(today.period).toBe('today');
    expect(today.totalCollected).toBe(150000);
    expect(today.totalInvoiced).toBe(150000);
  });
});

interface ListRow {
  id: string;
  nextAppointmentAt?: string | null;
  balance?: number;
}

describe('the patient list', () => {
  it('carries next visit and balance for a role that may see both', async () => {
    const rows = (await get<{ items: ListRow[] }>('/api/patients?q=Recall&pageSize=50'))
      .items;
    const booked = rows.find((r) => r.id === ids.booked)!;
    const due = rows.find((r) => r.id === ids.due)!;
    expect(booked.nextAppointmentAt).toEqual(expect.any(String));
    expect(due.nextAppointmentAt).toBeNull();
    // The invoice above was paid in full, so Due owes nothing.
    expect(due.balance).toBe(0);
  });

  it('leaves the balance out for a role that cannot read invoices', async () => {
    const email = `hyg-${Date.now()}@${s.a.subdomain}.test`;
    await owner().query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
       SELECT tenant_id, $2, password_hash, 'Hygienist', 'hygienist', 'active'
         FROM users WHERE id = $1`,
      [s.a.adminId, email],
    );
    const hyg = (await login(api, s.a.subdomain, email, s.password)).accessToken;
    const res = await call<{ items: ListRow[] }>(api, 'GET', '/api/patients?q=Recall', {
      token: hyg,
      subdomain: s.a.subdomain,
    });
    expect(res.status).toBe(200);
    const row = res.body.items.find((r) => r.id === ids.booked)!;
    expect(row.nextAppointmentAt).toEqual(expect.any(String));
    expect(row).not.toHaveProperty('balance');
  });
});
