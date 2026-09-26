import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { closePools, owner } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Inventory through the real HTTP surface, as both roles.
 *
 * inventory.itest.ts proves what the database refuses. This proves what the
 * API refuses, which is a different question with a different answer: the two
 * roles differ here, and the split is the part most likely to be got wrong
 * quietly. A receptionist who cannot record that gloves were used will simply
 * stop using the feature; one who can archive an item or move a reorder level
 * can silence a warning the doctor is relying on.
 *
 * It also proves the arithmetic survives the round trip. The unit suite tests
 * the engine and the integration suite tests the constraints, but only a real
 * request proves the service holds the running total and the movement history
 * in step.
 */

let api: TestApi;
let s: Scenario;
let adminToken: string;
let receptionToken: string;
let itemId: string;

/** A front-desk account in tenant A, created the way the platform would. */
async function createReceptionist(tenantId: string, password: string) {
  const email = `reception-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const hash = await bcrypt.hash(password, 4);
  await owner().query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
     VALUES ($1,$2,$3,'Front Desk','receptionist','active')`,
    [tenantId, email, hash],
  );
  return email;
}

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();

  const receptionEmail = await createReceptionist(s.a.id, s.password);
  adminToken = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  receptionToken = (await login(api, s.a.subdomain, receptionEmail, s.password))
    .accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

const asAdmin = (method: string, path: string, body?: unknown) =>
  call(api, method, path, { subdomain: s.a.subdomain, token: adminToken, body });

const asReception = (method: string, path: string, body?: unknown) =>
  call(api, method, path, { subdomain: s.a.subdomain, token: receptionToken, body });

describe('who may do what', () => {
  it('the doctor can add an item', async () => {
    const res = await asAdmin('POST', '/api/inventory', {
      name: 'Latex gloves M',
      category: 'Consumables',
      unit: 'box',
      quantity: 10,
      minimumQuantity: 4,
    });

    expect(res.status).toBe(201);
    const body = res.body as { id: string; quantity: number; lowStock: boolean };
    expect(body.quantity).toBe(10);
    expect(body.lowStock).toBe(false);
    itemId = body.id;
  });

  it('the front desk cannot add one', async () => {
    const res = await asReception('POST', '/api/inventory', {
      name: 'Something else',
      unit: 'box',
    });

    expect(res.status).toBe(403);
  });

  it('the front desk cannot move a reorder level', async () => {
    // The reason this is admin-only: lowering a minimum silences a warning
    // rather than recording a fact.
    const res = await asReception('PATCH', `/api/inventory/${itemId}`, {
      minimumQuantity: 0,
    });

    expect(res.status).toBe(403);
  });

  it('the front desk cannot archive an item', async () => {
    const res = await asReception('PATCH', `/api/inventory/${itemId}`, {
      status: 'archived',
    });

    expect(res.status).toBe(403);
  });

  it('but the front desk CAN read the stock list', async () => {
    const res = await asReception('GET', '/api/inventory');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('and CAN record what was used, which is the whole point', async () => {
    const res = await asReception('POST', `/api/inventory/${itemId}/movements`, {
      kind: 'usage',
      amount: 3,
    });

    expect(res.status).toBe(201);
    const body = res.body as { item: { quantity: number } };
    expect(body.item.quantity).toBe(7);
  });
});

describe('the running total and the history stay in step', () => {
  it('a receipt adds without anyone typing a sign', async () => {
    const res = await asAdmin('POST', `/api/inventory/${itemId}/movements`, {
      kind: 'receipt',
      amount: 5,
    });

    expect(res.status).toBe(201);
    expect((res.body as { item: { quantity: number } }).item.quantity).toBe(12);
  });

  it('a stock count sets the quantity to what was counted', async () => {
    const res = await asAdmin('POST', `/api/inventory/${itemId}/movements`, {
      kind: 'adjustment',
      countedQuantity: 9,
      reason: 'counted the shelf on Friday',
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      item: { quantity: number };
      movement: { quantityDelta: number };
    };
    expect(body.item.quantity).toBe(9);
    // 12 -> 9. Nobody typed -3; the count is what was entered.
    expect(body.movement.quantityDelta).toBe(-3);
  });

  it('every movement is on the record, in order', async () => {
    const res = await asAdmin('GET', `/api/inventory/${itemId}/movements`);

    expect(res.status).toBe(200);
    const rows = res.body as { kind: string; quantityAfter: number }[];
    // Newest first: adjustment (9), receipt (12), usage (7), opening (10).
    expect(rows.map((r) => r.kind)).toEqual([
      'adjustment',
      'receipt',
      'usage',
      'receipt',
    ]);
    expect(rows.map((r) => r.quantityAfter)).toEqual([9, 12, 7, 10]);
  });

  it('the opening stock is a movement too, not an unexplained starting number', async () => {
    const res = await asAdmin('GET', `/api/inventory/${itemId}/movements`);
    const rows = res.body as { reason: string | null }[];

    expect(rows[rows.length - 1].reason).toBe('Opening stock');
  });
});

describe('what the API refuses', () => {
  it('using more than is on the shelf, with a message that says what to do', async () => {
    const res = await asReception('POST', `/api/inventory/${itemId}/movements`, {
      kind: 'usage',
      amount: 500,
    });

    expect(res.status).toBe(400);
    expect(String((res.body as { message: string }).message)).toMatch(/stock count/);
  });

  it('a write-off with no reason', async () => {
    const res = await asReception('POST', `/api/inventory/${itemId}/movements`, {
      kind: 'write_off',
      amount: 1,
    });

    expect(res.status).toBe(400);
  });

  it('a stock count with no reason', async () => {
    const res = await asAdmin('POST', `/api/inventory/${itemId}/movements`, {
      kind: 'adjustment',
      countedQuantity: 3,
    });

    expect(res.status).toBe(400);
  });

  it('a negative quantity, rather than flipping it to a subtraction', async () => {
    const res = await asAdmin('POST', `/api/inventory/${itemId}/movements`, {
      kind: 'receipt',
      amount: -5,
    });

    expect(res.status).toBe(400);
  });

  it('a kind it does not recognise', async () => {
    const res = await asAdmin('POST', `/api/inventory/${itemId}/movements`, {
      kind: 'shrinkage',
      amount: 1,
    });

    expect(res.status).toBe(400);
  });

  it('a quantity set directly on the item, because that would bypass the history', async () => {
    const res = await asAdmin('PATCH', `/api/inventory/${itemId}`, { quantity: 999 });

    // forbidNonWhitelisted: the property is not on the DTO at all, so this is
    // refused rather than silently ignored.
    expect(res.status).toBe(400);
  });

  it('a second item with the same name', async () => {
    const res = await asAdmin('POST', '/api/inventory', {
      name: '  latex gloves m ',
      unit: 'box',
    });

    expect(res.status).toBe(409);
  });
});

describe('one clinic cannot reach another clinic’s stock', () => {
  let bItemId: string;

  beforeAll(async () => {
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO inventory_items (tenant_id, name, unit, quantity, minimum_quantity)
       VALUES ($1,'Clinic B gloves','box',5,1) RETURNING id`,
      [s.b.id],
    );
    bItemId = rows[0].id;
  });

  it('fetching it by id answers 404, not 403', async () => {
    const res = await asAdmin('GET', `/api/inventory/${bItemId}`);

    // 404, deliberately. 403 would confirm the id exists somewhere, which is
    // the difference between "not yours" and "no such thing".
    expect(res.status).toBe(404);
  });

  it('recording a movement against it answers 404', async () => {
    const res = await asAdmin('POST', `/api/inventory/${bItemId}/movements`, {
      kind: 'usage',
      amount: 1,
    });

    expect(res.status).toBe(404);
  });

  it('reading its history answers 404', async () => {
    const res = await asAdmin('GET', `/api/inventory/${bItemId}/movements`);

    expect(res.status).toBe(404);
  });

  it('and it never appears in the list', async () => {
    const res = await asAdmin('GET', '/api/inventory');
    const names = (res.body as { name: string }[]).map((i) => i.name);

    expect(names).not.toContain('Clinic B gloves');
  });
});

describe('low stock', () => {
  it('is flagged at the reorder level and surfaced by the alerts endpoint', async () => {
    // 9 in stock, reorder at 4. Take it to exactly 4.
    await asAdmin('POST', `/api/inventory/${itemId}/movements`, {
      kind: 'usage',
      amount: 5,
    });

    const item = await asAdmin('GET', `/api/inventory/${itemId}`);
    expect((item.body as { lowStock: boolean; quantity: number }).quantity).toBe(4);
    expect((item.body as { lowStock: boolean }).lowStock).toBe(true);

    const alerts = await asReception('GET', '/api/inventory/alerts');
    expect(alerts.status).toBe(200);
    const body = alerts.body as { lowCount: number; items: { id: string }[] };
    expect(body.lowCount).toBeGreaterThanOrEqual(1);
    expect(body.items.map((i) => i.id)).toContain(itemId);
  });

  it('an archived item drops out of the alerts', async () => {
    await asAdmin('PATCH', `/api/inventory/${itemId}`, { status: 'archived' });

    const alerts = await asAdmin('GET', '/api/inventory/alerts');
    const body = alerts.body as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).not.toContain(itemId);

    await asAdmin('PATCH', `/api/inventory/${itemId}`, { status: 'active' });
  });

  it('and an archived item refuses new movements until it is restored', async () => {
    await asAdmin('PATCH', `/api/inventory/${itemId}`, { status: 'archived' });

    const res = await asReception('POST', `/api/inventory/${itemId}/movements`, {
      kind: 'usage',
      amount: 1,
    });

    expect(res.status).toBe(409);

    await asAdmin('PATCH', `/api/inventory/${itemId}`, { status: 'active' });
  });
});
