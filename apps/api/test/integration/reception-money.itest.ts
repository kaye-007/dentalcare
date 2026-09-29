import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { closePools, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * What reception may do with money (the owner's decision, 2026-09-28).
 *
 * It takes payments, and it reads the chart it explains the bill from. It
 * does not reverse a payment or an expense — the administrator does — and it
 * does not see what the clinic spends. The API is where that is decided; the
 * app only hides what the API would refuse.
 */

let api: TestApi;
let s: Scenario;
let admin: string;
let desk: string;

const as = (token: string, body?: unknown) => ({ token, subdomain: s.a.subdomain, body });

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  const email = `reception@${s.a.subdomain}.test`;
  await owner().query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
     VALUES ($1,$2,$3,'Reception person','receptionist','active')`,
    [s.a.id, email, await bcrypt.hash(s.password, 4)],
  );
  admin = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  desk = (await login(api, s.a.subdomain, email, s.password)).accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

/** An invoice raised by the doctor and paid by card at the desk. */
async function paidAtTheDesk(): Promise<string> {
  const invoice = await call<{ id: string }>(
    api,
    'POST',
    '/api/invoices',
    as(admin, {
      patientId: s.a.patientId,
      items: [{ description: 'Kontroll', quantity: 1, unitPrice: 150_000 }],
    }),
  );
  expect(invoice.status).toBe(201);
  const paid = await call(
    api,
    'POST',
    `/api/invoices/${invoice.body.id}/payments`,
    as(desk, { amount: 150_000, method: 'card' }),
  );
  expect(paid.status).toBe(201);
  const { rows } = await ownerQuery<{ id: string }>(
    'SELECT id FROM payments WHERE invoice_id = $1',
    [invoice.body.id],
  );
  return rows[0]!.id;
}

const voidedAt = async (table: 'payments' | 'expenses', id: string) =>
  (
    await ownerQuery<{ voided_at: Date | null }>(
      `SELECT voided_at FROM ${table} WHERE id = $1`,
      [id],
    )
  ).rows[0]!.voided_at;

describe('reception and money', () => {
  it('takes a payment, but cannot void it; the administrator can', async () => {
    const payment = await paidAtTheDesk();

    const refused = await call(
      api,
      'POST',
      `/api/payments/${payment}/void`,
      as(desk, { reason: 'Mistyped amount' }),
    );
    expect(refused.status).toBe(403);
    expect(await voidedAt('payments', payment)).toBeNull();

    const voided = await call(
      api,
      'POST',
      `/api/payments/${payment}/void`,
      as(admin, { reason: 'Mistyped amount' }),
    );
    expect(voided.status).toBe(201);
    expect(await voidedAt('payments', payment)).not.toBeNull();
  });

  it('is refused for what it may not do before it is asked for a key', async () => {
    const payment = await paidAtTheDesk();
    const refused = await call(api, 'POST', `/api/payments/${payment}/void`, {
      ...as(desk, { reason: 'Mistyped amount' }),
      idempotencyKey: null,
    });
    expect(refused.status).toBe(403);
  });

  it('does not see the expenses, and cannot void one', async () => {
    const expense = await call<{ id: string }>(
      api,
      'POST',
      '/api/expenses',
      as(admin, { category: 'materials', amount: 90_000, note: 'Doreza' }),
    );
    expect(expense.status).toBe(201);

    expect((await call(api, 'GET', '/api/expenses', as(desk))).status).toBe(403);

    const refused = await call(
      api,
      'POST',
      `/api/expenses/${expense.body.id}/void`,
      as(desk, { reason: 'Entered twice' }),
    );
    expect(refused.status).toBe(403);
    expect(await voidedAt('expenses', expense.body.id)).toBeNull();
  });

  it('still reads the chart it explains the bill from', async () => {
    const chart = await call(
      api,
      'GET',
      `/api/patients/${s.a.patientId}/chart`,
      as(desk),
    );
    expect(chart.status).toBe(200);
  });
});
