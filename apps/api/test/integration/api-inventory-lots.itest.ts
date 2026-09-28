import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { asTenant, closePools, errorCodeOf, owner } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Lots, expiry and recalls (0007), through the API and against the database.
 *
 * The questions a clinic could not answer before this: which stock expires
 * soon, and — when a manufacturer recalls a batch — which patients received
 * it. The answers are only worth having if they are complete, so this also
 * proves the database refuses the shortcuts that would make them incomplete:
 * a movement with no lot, a stock level that drifts from its lots, a deleted
 * lot, an undone recall.
 */

const DENIED = '42501';
const CHECK_VIOLATION = '23514';
const LOCKED = '55000';

let api: TestApi;
let s: Scenario;
let adminToken: string;
let receptionToken: string;
let itemId: string;

/** A calendar date `offset` days from now, as the API takes it. */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

interface Lot {
  id: string;
  lotNumber: string;
  quantity: number;
  status: string;
  expiry: string;
  expiresOn: string | null;
}

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();

  const email = `reception-${Math.random().toString(36).slice(2, 8)}@test.local`;
  await owner().query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
     VALUES ($1,$2,$3,'Front Desk','receptionist','active')`,
    [s.a.id, email, await bcrypt.hash(s.password, 4)],
  );
  adminToken = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  receptionToken = (await login(api, s.a.subdomain, email, s.password)).accessToken;
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

const move = (body: Record<string, unknown>, as = asAdmin) =>
  as('POST', `/api/inventory/${itemId}/movements`, body);

async function lotsOf(id: string): Promise<Lot[]> {
  const res = await asAdmin('GET', `/api/inventory/${id}/lots`);
  expect(res.status).toBe(200);
  return res.body as Lot[];
}

async function lotNamed(lotNumber: string): Promise<Lot> {
  const lot = (await lotsOf(itemId)).find((l) => l.lotNumber === lotNumber);
  if (!lot) throw new Error(`no lot ${lotNumber}`);
  return lot;
}

describe('receiving into lots', () => {
  it('refuses opening stock of a tracked item without its lot number', async () => {
    const res = await asAdmin('POST', '/api/inventory', {
      name: 'Articaine 4%',
      unit: 'cartridge',
      quantity: 50,
      trackLots: true,
    });
    expect(res.status).toBe(400);
  });

  it('records opening stock as the item’s first lot', async () => {
    const res = await asAdmin('POST', '/api/inventory', {
      name: 'Articaine 4%',
      unit: 'cartridge',
      quantity: 50,
      trackLots: true,
      expiryWarningDays: 30,
      lotNumber: 'ART-LATE',
      expiresOn: day(400),
    });
    expect(res.status).toBe(201);
    itemId = (res.body as { id: string }).id;

    const lots = await lotsOf(itemId);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ lotNumber: 'ART-LATE', quantity: 50, expiry: 'ok' });
  });

  it('refuses a delivery without a lot number', async () => {
    expect((await move({ kind: 'receipt', amount: 10 })).status).toBe(400);
  });

  it('refuses stock that is already past its date', async () => {
    const res = await move({
      kind: 'receipt',
      amount: 10,
      lotNumber: 'ART-OLD',
      expiresOn: day(-3),
    });
    expect(res.status).toBe(400);
  });

  it('creates a lot on first arrival and adds to it when more arrives', async () => {
    expect(
      (
        await move({
          kind: 'receipt',
          amount: 20,
          lotNumber: 'ART-SOON',
          expiresOn: day(10),
        })
      ).status,
    ).toBe(201);
    // Typed differently the second time — it is still the same lot.
    expect(
      (await move({ kind: 'receipt', amount: 5, lotNumber: ' art-soon ' })).status,
    ).toBe(201);

    expect(await lotNamed('ART-SOON')).toMatchObject({
      quantity: 25,
      expiry: 'expiring',
    });
    const item = await asAdmin('GET', `/api/inventory/${itemId}`);
    expect((item.body as { quantity: number }).quantity).toBe(75);
  });

  it('refuses a second expiry date for the same lot', async () => {
    const res = await move({
      kind: 'receipt',
      amount: 1,
      lotNumber: 'ART-SOON',
      expiresOn: day(90),
    });
    expect(res.status).toBe(409);
  });
});

describe('using stock', () => {
  it('takes the earliest-expiring lot when none is chosen, and records the patient', async () => {
    const res = await move(
      { kind: 'usage', amount: 2, patientId: s.a.patientId },
      asReception,
    );
    expect(res.status).toBe(201);
    const movement = (res.body as { movement: { id: string; lotNumber: string } })
      .movement;
    expect(movement.lotNumber).toBe('ART-SOON');

    const recent = await asAdmin('GET', `/api/inventory/${itemId}/movements`);
    const row = (recent.body as { id: string; patientName: string | null }[]).find(
      (m) => m.id === movement.id,
    );
    expect(row?.patientName).toBeTruthy();
  });

  describe('a lot that expired on the shelf', () => {
    let expiredId: string;

    beforeAll(async () => {
      // Seeded directly, lot and item in one transaction so they still agree.
      const client = await owner().connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO inventory_lots (tenant_id, item_id, lot_number, expires_on, quantity)
           VALUES ($1,$2,'ART-EXPIRED',$3,4) RETURNING id`,
          [s.a.id, itemId, day(-2)],
        );
        expiredId = rows[0]!.id;
        await client.query(
          'UPDATE inventory_items SET quantity = quantity + 4 WHERE id = $1',
          [itemId],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });

    it('cannot be used on a patient when chosen by hand', async () => {
      const res = await move({ kind: 'usage', amount: 1, lotId: expiredId });
      expect(res.status).toBe(409);
    });

    it('is skipped when the lot is picked automatically', async () => {
      const res = await move({ kind: 'usage', amount: 1 });
      expect(res.status).toBe(201);
      expect((res.body as { movement: { lotNumber: string } }).movement.lotNumber).toBe(
        'ART-SOON',
      );
    });

    it('can be written off', async () => {
      const res = await move({
        kind: 'write_off',
        amount: 4,
        lotId: expiredId,
        reason: 'Expired on the shelf',
      });
      expect(res.status).toBe(201);
    });
  });

  it('asks which lot when writing off or counting', async () => {
    expect(
      (await move({ kind: 'write_off', amount: 1, reason: 'Dropped a box' })).status,
    ).toBe(400);
    expect(
      (await move({ kind: 'adjustment', countedQuantity: 3, reason: 'Shelf count' }))
        .status,
    ).toBe(400);
  });

  it('refuses a lot number on an item that does not track lots', async () => {
    const created = await asAdmin('POST', '/api/inventory', {
      name: 'Cotton rolls',
      unit: 'pack',
      quantity: 100,
    });
    expect(created.status).toBe(201);
    const res = await asAdmin(
      'POST',
      `/api/inventory/${(created.body as { id: string }).id}/movements`,
      { kind: 'receipt', amount: 5, lotNumber: 'X1' },
    );
    expect(res.status).toBe(400);
  });

  it('surfaces lots close to their date in the alerts', async () => {
    const res = await asReception('GET', '/api/inventory/alerts');
    expect(res.status).toBe(200);
    const body = res.body as { expiringLots: Lot[]; expiringCount: number };
    expect(body.expiringLots.map((l) => l.lotNumber)).toContain('ART-SOON');
    expect(body.expiringCount).toBeGreaterThanOrEqual(1);
  });
});

describe('recalls', () => {
  let soon: Lot;

  beforeAll(async () => {
    soon = await lotNamed('ART-SOON');
  });

  it('the front desk cannot recall a lot', async () => {
    const res = await asReception('POST', `/api/inventory/lots/${soon.id}/recall`, {
      reason: 'Looks wrong',
    });
    expect(res.status).toBe(403);
  });

  it('the doctor can, and learns how many patients received it', async () => {
    const res = await asAdmin('POST', `/api/inventory/lots/${soon.id}/recall`, {
      reason: 'Manufacturer notice 14/2026',
    });
    expect(res.status).toBe(201);
    const body = res.body as { lot: Lot; patientsAffected: number };
    expect(body.lot.status).toBe('recalled');
    expect(body.patientsAffected).toBe(1);
  });

  it('lists who received it, and how much cannot be traced', async () => {
    const res = await asAdmin('GET', `/api/inventory/lots/${soon.id}/usage`);
    expect(res.status).toBe(200);
    const body = res.body as {
      uses: { patientId: string | null }[];
      patientCount: number;
      unattributedQuantity: number;
    };
    expect(body.patientCount).toBe(1);
    expect(body.uses.some((u) => u.patientId === s.a.patientId)).toBe(true);
    // The automatic pick above used 1 with no patient recorded.
    expect(body.unattributedQuantity).toBe(1);
  });

  it('a recalled lot cannot be used or restocked', async () => {
    expect((await move({ kind: 'usage', amount: 1, lotId: soon.id })).status).toBe(409);
    expect(
      (await move({ kind: 'receipt', amount: 1, lotNumber: 'ART-SOON' })).status,
    ).toBe(409);
  });

  it('recalled stock still on the shelf is flagged', async () => {
    const res = await asAdmin('GET', '/api/inventory/alerts');
    const body = res.body as { recalledLots: Lot[]; expiringLots: Lot[] };
    expect(body.recalledLots.map((l) => l.id)).toContain(soon.id);
    expect(body.expiringLots.map((l) => l.id)).not.toContain(soon.id);
  });

  it('but it can still be written off', async () => {
    const onShelf = (await lotNamed('ART-SOON')).quantity;
    const res = await move({
      kind: 'write_off',
      amount: onShelf,
      lotId: soon.id,
      reason: 'Returned under recall',
    });
    expect(res.status).toBe(201);
  });
});

describe('switching lot tracking', () => {
  it('turning it on keeps the stock already on the shelf, as one lot', async () => {
    const created = await asAdmin('POST', '/api/inventory', {
      name: 'Composite A2',
      unit: 'syringe',
      quantity: 7,
    });
    const id = (created.body as { id: string }).id;

    const res = await asAdmin('PATCH', `/api/inventory/${id}`, { trackLots: true });
    expect(res.status).toBe(200);
    expect((res.body as { trackLots: boolean }).trackLots).toBe(true);

    const lots = await lotsOf(id);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ quantity: 7, expiresOn: null });
  });

  it('turning it off once lots exist is refused', async () => {
    const res = await asAdmin('PATCH', `/api/inventory/${itemId}`, { trackLots: false });
    expect(res.status).toBe(409);
  });
});

describe('what the database refuses, whatever the service does', () => {
  it('a movement of a lot-tracked item that names no lot', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `INSERT INTO stock_movements (tenant_id, item_id, kind, quantity_delta, quantity_after)
           VALUES ($1,$2,'receipt',1,999)`,
          [s.a.id, itemId],
        ),
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('a stock level that no longer matches its lots', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('UPDATE inventory_items SET quantity = quantity + 1 WHERE id = $1', [
          itemId,
        ]),
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('deleting a lot', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('DELETE FROM inventory_lots WHERE item_id = $1', [itemId]),
      ),
    );
    expect(code).toBe(DENIED);
  });

  it('rewriting a lot number', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(`UPDATE inventory_lots SET lot_number = 'SWAPPED' WHERE item_id = $1`, [
          itemId,
        ]),
      ),
    );
    expect(code).toBe(DENIED);
  });

  it('undoing a recall', async () => {
    const soon = await lotNamed('ART-SOON');
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `UPDATE inventory_lots
              SET status = 'active', recalled_at = NULL, recall_reason = NULL
            WHERE id = $1`,
          [soon.id],
        ),
      ),
    );
    expect(code).toBe(LOCKED);
  });

  it('another clinic sees none of it', async () => {
    const rows = await asTenant(s.b.id, (c) => c.query('SELECT id FROM inventory_lots'));
    expect(rows.rowCount).toBe(0);
  });
});
