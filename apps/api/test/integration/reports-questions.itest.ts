import { call, login, startApi, TestApi } from './api';
import { closePools, owner } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Reports answer questions on the clinic's own calendar: a payment taken at
 * 00:30 in Tirana is that day's money, and the default period ends on the
 * clinic's today. The overview also says what was done in the chair, what it
 * used up, and where the lab work stands.
 *
 * 2 March 2027 in Tirana is UTC+1 (winter), so 00:30 there is 23:30Z on 1 March.
 */

let api: TestApi;
let s: Scenario;
let token: string;

interface Overview {
  range: { from: string; to: string };
  totals: {
    collected: number;
    appointmentsCancelled: number;
    appointmentsNoShow: number;
  };
  treatmentsPerformed: { label: string; value: number }[];
  consumption: { label: string; unit: string; value: number }[];
  lab: { ordered: number; fitted: number; open: number; late: number; cost: number };
}

const overview = (q: string) =>
  call<Overview>(api, 'GET', `/api/reports/overview${q}`, {
    token,
    subdomain: s.a.subdomain,
  });

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  token = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;

  const t = s.a.id;
  const inv = await owner().query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, patient_id, seq, invoice_number, total, subtotal, status)
     VALUES ($1, $2, 9001, 'INV-9001', 5000, 5000, 'unpaid') RETURNING id`,
    [t, s.a.patientId],
  );
  await owner().query(
    `INSERT INTO payments (tenant_id, invoice_id, amount, method, paid_at)
     VALUES ($1, $2, 5000, 'cash', '2027-03-01T23:30:00Z')`,
    [t, inv.rows[0]!.id],
  );
  await owner().query(
    `INSERT INTO appointments (tenant_id, patient_id, reason, status, starts_at, ends_at,
                               cancelled_at, cancel_reason)
     VALUES ($1, $2, 'Kontroll', 'cancelled', '2027-03-02T08:00:00Z', '2027-03-02T08:30:00Z',
             now(), 'Illness'),
            ($1, $2, 'Kontroll', 'no_show', '2027-03-02T09:00:00Z', '2027-03-02T09:30:00Z',
             NULL, NULL)`,
    [t, s.a.patientId],
  );
  await owner().query(
    `INSERT INTO clinical_procedures (tenant_id, patient_id, description, status, performed_on)
     VALUES ($1, $2, 'Mbushje kompozit', 'completed', '2027-03-02'),
            ($1, $2, 'Mbushje kompozit', 'completed', '2027-03-02')`,
    [t, s.a.patientId],
  );
  const item = await owner().query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, unit, quantity) VALUES ($1, 'Doreza', 'copë', 40)
     RETURNING id`,
    [t],
  );
  await owner().query(
    `INSERT INTO stock_movements (tenant_id, item_id, kind, quantity_delta, quantity_after, created_at)
     VALUES ($1, $2, 'usage', -6, 34, '2027-03-02T10:00:00Z')`,
    [t, item.rows[0]!.id],
  );
  await owner().query(
    `INSERT INTO lab_orders (tenant_id, patient_id, work, status, cost, sent_at, received_at,
                             fitted_at, created_at)
     VALUES ($1, $2, 'Kurorë zirkoni', 'fitted', 1800000,
             '2027-02-20T10:00:00Z', '2027-02-27T10:00:00Z', '2027-03-02T11:00:00Z',
             '2027-03-02T07:00:00Z')`,
    [t, s.a.patientId],
  );
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('reports on the clinic’s calendar', () => {
  it('counts a payment at 00:30 in Tirana on that day, not the day before', async () => {
    const that = await overview('?from=2027-03-02&to=2027-03-02');
    expect(that.body.totals.collected).toBe(5000);
    const before = await overview('?from=2027-03-01&to=2027-03-01');
    expect(before.body.totals.collected).toBe(0);
  });

  it('ends the default period on the clinic’s today', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Tirane',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const res = await overview('');
    expect(res.body.range.to).toBe(today);
    const vat = await call<{ to: string }>(api, 'GET', '/api/reports/vat', {
      token,
      subdomain: s.a.subdomain,
    });
    expect(vat.body.to).toBe(today);
  });

  it('says what was cancelled, done in the chair, used up, and made by the lab', async () => {
    const { body } = await overview('?from=2027-03-02&to=2027-03-02');
    expect(body.totals).toMatchObject({
      appointmentsCancelled: 1,
      appointmentsNoShow: 1,
    });
    expect(body.treatmentsPerformed).toEqual([{ label: 'Mbushje kompozit', value: 2 }]);
    expect(body.consumption).toEqual([{ label: 'Doreza', unit: 'copë', value: 6 }]);
    expect(body.lab).toMatchObject({ ordered: 1, fitted: 1, cost: 1800000 });
  });
});
