import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { asTenant, closePools, errorCodeOf, owner } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Lab work and the labs and suppliers behind it (0020): where a crown is, who
 * may move it, that its steps are stamped and can be undone, that it is late
 * on the clinic's clock, and that one clinic never sees another's.
 */

let api: TestApi;
let s: Scenario;
let admin: string;
let reception: string;
let accountant: string;
let adminB: string;
let labId: string;
let orderId: string;

const A = (token: string, body?: unknown) => ({ token, subdomain: s.a.subdomain, body });

interface Order {
  id: string;
  status: string;
  sentAt: string | null;
  receivedAt: string | null;
  fittedAt: string | null;
  overdue: boolean;
  labName: string | null;
  teeth: number[];
  patientName: string;
}

async function user(role: string, email: string) {
  await owner().query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
     VALUES ($1, $2, $3, $4, $5, 'active')`,
    [s.a.id, email, await bcrypt.hash(s.password, 4), `${role} ${email}`, role],
  );
  return (await login(api, s.a.subdomain, email, s.password)).accessToken;
}

const move = (id: string, status: string, reason?: string) =>
  call<Order>(
    api,
    'POST',
    `/api/lab-orders/${id}/status`,
    A(reception, { status, reason }),
  );

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  admin = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  adminB = (await login(api, s.b.subdomain, s.b.adminEmail, s.password)).accessToken;
  reception = await user('receptionist', `desk@${s.a.subdomain}.test`);
  accountant = await user('accountant', `books@${s.a.subdomain}.test`);
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('labs', () => {
  it('are added once per name, however it is typed', async () => {
    const res = await call<{ id: string }>(
      api,
      'POST',
      '/api/labs',
      A(admin, { name: 'Dental Lab Tirana', phone: '+355 69 111 2222' }),
    );
    expect(res.status).toBe(201);
    labId = res.body.id;
    const again = await call(
      api,
      'POST',
      '/api/labs',
      A(admin, { name: ' dental lab TIRANA ' }),
    );
    expect(again.status).toBe(409);
  });

  it('are not a supplier, and a retired one is not offered', async () => {
    const suppliers = await call<unknown[]>(api, 'GET', '/api/suppliers', A(admin));
    expect(suppliers.body).toEqual([]);
    const old = await call<{ id: string }>(
      api,
      'POST',
      '/api/labs',
      A(admin, { name: 'Old Lab' }),
    );
    await call(api, 'PATCH', `/api/labs/${old.body.id}`, A(admin, { isActive: false }));
    const labs = await call<{ name: string }[]>(api, 'GET', '/api/labs', A(reception));
    expect(labs.body.map((l) => l.name)).toEqual(['Dental Lab Tirana']);
  });
});

describe('lab work', () => {
  it('is ordered by reception for a patient, and is late on the clinic’s clock', async () => {
    const res = await call<Order>(
      api,
      'POST',
      '/api/lab-orders',
      A(reception, {
        patientId: s.a.patientId,
        work: 'E-max crown',
        teeth: [36, 36],
        labId,
        dueOn: '2020-01-01',
        cost: 1500000,
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'preparing',
      labName: 'Dental Lab Tirana',
      teeth: [36],
      overdue: true,
    });
    orderId = res.body.id;

    const summary = await call<{ open: number; overdue: number; ready: number }>(
      api,
      'GET',
      '/api/lab-orders/summary',
      A(admin),
    );
    expect(summary.body).toMatchObject({ open: 1, overdue: 1, ready: 0 });
  });

  it('is stamped as it moves, and a step can be undone', async () => {
    const sent = await move(orderId, 'sent');
    expect(sent.status).toBe(201);
    expect(sent.body.sentAt).not.toBeNull();

    const undone = await move(orderId, 'preparing');
    expect(undone.body).toMatchObject({ status: 'preparing', sentAt: null });

    // Back from the lab before anyone marked it sent: both stamps are filled.
    const back = await move(orderId, 'received');
    expect(back.body.status).toBe('received');
    expect(back.body.sentAt).not.toBeNull();
    expect(back.body.receivedAt).not.toBeNull();
    // Back at the clinic is not late, whatever the due date said.
    expect(back.body.overdue).toBe(false);

    expect((await move(orderId, 'preparing')).status).toBe(409);
  });

  it('takes back a Fitted at once, and is final once it has settled', async () => {
    const fitted = await move(orderId, 'fitted');
    expect(fitted.body.fittedAt).not.toBeNull();
    // The Undo on the screen.
    const undone = await move(orderId, 'received');
    expect(undone.body).toMatchObject({ status: 'received', fittedAt: null });

    // Fitted again, eleven minutes ago: it has settled, and nothing moves it.
    await move(orderId, 'fitted');
    await owner().query(
      `UPDATE lab_orders SET fitted_at = now() - interval '11 minutes' WHERE id = $1`,
      [orderId],
    );
    expect((await move(orderId, 'received')).status).toBe(409);
    expect((await move(orderId, 'cancelled', 'Changed mind')).status).toBe(409);
  });

  it('is cancelled with a reason, and reinstated to where it was', async () => {
    const res = await call<Order>(
      api,
      'POST',
      '/api/lab-orders',
      A(reception, { patientId: s.a.patientId, work: 'Night guard' }),
    );
    const id = res.body.id;
    await move(id, 'sent');
    expect((await move(id, 'cancelled')).status).toBe(400);
    expect((await move(id, 'cancelled', 'Patient postponed')).body.status).toBe(
      'cancelled',
    );
    expect((await move(id, 'preparing')).status).toBe(409);
    const back = await move(id, 'sent');
    expect(back.body).toMatchObject({ status: 'sent' });
  });

  it('refuses a plan line that belongs to another patient', async () => {
    const other = await owner().query<{ id: string }>(
      `INSERT INTO patients (tenant_id, first_name, last_name) VALUES ($1,'Ana','Other') RETURNING id`,
      [s.a.id],
    );
    const plan = await owner().query<{ id: string }>(
      `INSERT INTO treatment_plans (tenant_id, patient_id, title) VALUES ($1,$2,'Plan') RETURNING id`,
      [s.a.id, other.rows[0]!.id],
    );
    const item = await owner().query<{ id: string }>(
      `INSERT INTO treatment_plan_items (tenant_id, plan_id, description) VALUES ($1,$2,'Crown') RETURNING id`,
      [s.a.id, plan.rows[0]!.id],
    );
    const res = await call(
      api,
      'POST',
      '/api/lab-orders',
      A(admin, { patientId: s.a.patientId, work: 'Crown', planItemId: item.rows[0]!.id }),
    );
    expect(res.status).toBe(400);
  });

  it('is not the accountant’s to read', async () => {
    expect((await call(api, 'GET', '/api/lab-orders', A(accountant))).status).toBe(403);
    expect((await call(api, 'GET', '/api/labs', A(accountant))).status).toBe(403);
  });

  it('is invisible to another clinic, which cannot move it either', async () => {
    const theirs = await call<Order[]>(api, 'GET', '/api/lab-orders?scope=done', {
      token: adminB,
      subdomain: s.b.subdomain,
    });
    expect(theirs.body).toEqual([]);
    const res = await call(api, 'POST', `/api/lab-orders/${orderId}/status`, {
      token: adminB,
      subdomain: s.b.subdomain,
      body: { status: 'received' },
    });
    expect(res.status).toBe(404);
  });

  it('can never be deleted, only cancelled', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) => c.query('DELETE FROM lab_orders WHERE id = $1', [orderId])),
    );
    expect(code).toBe('42501');
  });
});

describe('suppliers', () => {
  it('are named by the desk, and an item says who to reorder from', async () => {
    const sup = await call<{ id: string }>(
      api,
      'POST',
      '/api/suppliers',
      A(reception, { name: 'Medident', phone: '068 222 3333' }),
    );
    expect(sup.status).toBe(201);
    const item = await owner().query<{ id: string }>(
      `INSERT INTO inventory_items (tenant_id, name, unit, quantity, minimum_quantity)
       VALUES ($1, 'Gloves M', 'box', 1, 5) RETURNING id`,
      [s.a.id],
    );
    const set = await call<{ supplierName: string }>(
      api,
      'PUT',
      `/api/inventory/${item.rows[0]!.id}/supplier`,
      A(reception, { supplierId: sup.body.id }),
    );
    expect(set.status).toBe(200);
    expect(set.body.supplierName).toBe('Medident');

    const alerts = await call<{ items: { name: string; supplierName: string | null }[] }>(
      api,
      'GET',
      '/api/inventory/alerts',
      A(reception),
    );
    expect(alerts.body.items).toContainEqual(
      expect.objectContaining({ name: 'Gloves M', supplierName: 'Medident' }),
    );
  });

  it('cannot be a lab', async () => {
    const item = await owner().query<{ id: string }>(
      `INSERT INTO inventory_items (tenant_id, name, unit) VALUES ($1, 'Composite A2', 'syringe') RETURNING id`,
      [s.a.id],
    );
    const res = await call(
      api,
      'PUT',
      `/api/inventory/${item.rows[0]!.id}/supplier`,
      A(reception, { supplierId: labId }),
    );
    expect(res.status).toBe(404);
  });
});
