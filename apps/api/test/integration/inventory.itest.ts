import { asTenant, closePools, errorCodeOf, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Inventory, against the real database as the real runtime role.
 *
 * Three things are asserted here and nowhere else, because none of them can be
 * proved without a database:
 *
 *   1. Isolation — one clinic's stock is invisible to another, including by
 *      exact id. Same property as patients; a new table is a new chance to
 *      forget the policy.
 *   2. Append-only movements — the runtime role holds no UPDATE and no DELETE
 *      on stock_movements. A controller bug cannot reach what the grant does
 *      not give.
 *   3. The CHECK constraints that give a movement its meaning: a `usage`
 *      cannot add stock, a `receipt` cannot remove it, and no path leaves a
 *      shelf holding a negative quantity.
 *
 * The unit suite (stock-engine.spec.ts) proves the arithmetic. This proves the
 * database would refuse it even if the arithmetic were wrong.
 */

const DENIED = '42501'; // insufficient_privilege
const CHECK_VIOLATION = '23514';
const RLS_VIOLATION = '42501';

let s: Scenario;
let itemA: string;
let itemB: string;

async function makeItem(
  tenantId: string,
  name: string,
  quantity = 10,
  minimum = 4,
): Promise<string> {
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, unit, quantity, minimum_quantity)
     VALUES ($1, $2, 'box', $3, $4) RETURNING id`,
    [tenantId, name, quantity, minimum],
  );
  return rows[0].id;
}

beforeAll(async () => {
  s = await createScenario();
  itemA = await makeItem(s.a.id, 'Gloves M');
  // Deliberately the SAME name in the other clinic: uniqueness is per tenant,
  // and two clinics both stocking gloves must not collide.
  itemB = await makeItem(s.b.id, 'Gloves M');
});

afterAll(async () => {
  await destroyScenario(s);
  await closePools();
});

describe('stock is isolated per clinic', () => {
  it('a clinic sees only its own items', async () => {
    const rows = await asTenant(s.a.id, (c) =>
      c.query<{ id: string }>('SELECT id FROM inventory_items'),
    );

    expect(rows.rows.map((r) => r.id)).toEqual([itemA]);
  });

  it('another clinic’s item is not readable by its exact id', async () => {
    const rows = await asTenant(s.a.id, (c) =>
      c.query('SELECT id FROM inventory_items WHERE id = $1', [itemB]),
    );

    // Not a filtered empty list — the row is not visible at all, so the API
    // answers 404 for an id that exists in another clinic and for one that
    // does not exist. Those must be indistinguishable.
    expect(rows.rowCount).toBe(0);
  });

  it('a clinic cannot create an item inside another', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `INSERT INTO inventory_items (tenant_id, name, unit) VALUES ($1,'Smuggled','box')`,
          [s.b.id],
        ),
      ),
    );

    expect(code).toBe(RLS_VIOLATION);
  });

  it('a clinic cannot move its own item into another', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('UPDATE inventory_items SET tenant_id = $1 WHERE id = $2', [
          s.b.id,
          itemA,
        ]),
      ),
    );

    expect(code).toBe(RLS_VIOLATION);
  });

  it('another clinic’s movements are invisible', async () => {
    await owner().query(
      `INSERT INTO stock_movements (tenant_id, item_id, kind, quantity_delta, quantity_after)
       VALUES ($1,$2,'usage',-1,9)`,
      [s.b.id, itemB],
    );

    const rows = await asTenant(s.a.id, (c) => c.query('SELECT id FROM stock_movements'));

    expect(rows.rowCount).toBe(0);
  });

  it('two clinics may both stock an item of the same name', async () => {
    const { rows } = await ownerQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_items
        WHERE name = 'Gloves M' AND tenant_id IN ($1,$2)`,
      [s.a.id, s.b.id],
    );

    expect(rows[0].count).toBe('2');
  });

  it('but one clinic may not stock the same name twice, however it is typed', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `INSERT INTO inventory_items (tenant_id, name, unit) VALUES ($1,'  gloves m ','box')`,
          [s.a.id],
        ),
      ),
    );

    expect(code).toBe('23505');
  });
});

describe('movements are append-only', () => {
  let movementId: string;

  beforeAll(async () => {
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO stock_movements (tenant_id, item_id, kind, quantity_delta, quantity_after, reason)
       VALUES ($1,$2,'usage',-2,8,'treated a patient') RETURNING id`,
      [s.a.id, itemA],
    );
    movementId = rows[0].id;
  });

  it('cannot be edited', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('UPDATE stock_movements SET quantity_delta = -1 WHERE id = $1', [
          movementId,
        ]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  it('cannot be deleted', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('DELETE FROM stock_movements WHERE id = $1', [movementId]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  it('the reason cannot be rewritten afterwards', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('UPDATE stock_movements SET reason = $1 WHERE id = $2', [
          'something else entirely',
          movementId,
        ]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  it('an item cannot be deleted, because its history would go with it', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('DELETE FROM inventory_items WHERE id = $1', [itemA]),
      ),
    );

    expect(code).toBe(DENIED);
  });

  it('but it CAN be archived, which is the supported removal', async () => {
    await asTenant(s.a.id, (c) =>
      c.query(`UPDATE inventory_items SET status = 'archived' WHERE id = $1`, [itemA]),
    );

    const { rows } = await ownerQuery<{ status: string }>(
      'SELECT status FROM inventory_items WHERE id = $1',
      [itemA],
    );
    expect(rows[0].status).toBe('archived');

    await owner().query(`UPDATE inventory_items SET status = 'active' WHERE id = $1`, [
      itemA,
    ]);
  });
});

describe('a movement has to mean what it is called', () => {
  it.each([
    ['usage that adds stock', 'usage', 5, 15],
    ['a receipt that removes stock', 'receipt', -5, 5],
    ['a write-off that adds stock', 'write_off', 3, 13],
  ])('refuses %s', async (_label, kind, delta, after) => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `INSERT INTO stock_movements (tenant_id, item_id, kind, quantity_delta, quantity_after)
           VALUES ($1,$2,$3,$4,$5)`,
          [s.a.id, itemA, kind, delta, after],
        ),
      ),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it('allows an adjustment in either direction, because a count can go both ways', async () => {
    await expect(
      asTenant(s.a.id, (c) =>
        c.query(
          `INSERT INTO stock_movements (tenant_id, item_id, kind, quantity_delta, quantity_after, reason)
           VALUES ($1,$2,'adjustment',-3,5,'counted the shelf'),
                  ($1,$2,'adjustment', 2,7,'found a box in the back')`,
          [s.a.id, itemA],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a movement of zero, which would record nothing', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `INSERT INTO stock_movements (tenant_id, item_id, kind, quantity_delta, quantity_after)
           VALUES ($1,$2,'adjustment',0,10)`,
          [s.a.id, itemA],
        ),
      ),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it('refuses an unknown kind', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `INSERT INTO stock_movements (tenant_id, item_id, kind, quantity_delta, quantity_after)
           VALUES ($1,$2,'shrinkage',-1,9)`,
          [s.a.id, itemA],
        ),
      ),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('a shelf cannot hold a negative quantity', () => {
  it('not on the item', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('UPDATE inventory_items SET quantity = -1 WHERE id = $1', [itemA]),
      ),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it('and not as the result recorded on a movement', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query(
          `INSERT INTO stock_movements (tenant_id, item_id, kind, quantity_delta, quantity_after)
           VALUES ($1,$2,'usage',-50,-40)`,
          [s.a.id, itemA],
        ),
      ),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it('a reorder level cannot be negative either', async () => {
    const code = await errorCodeOf(
      asTenant(s.a.id, (c) =>
        c.query('UPDATE inventory_items SET minimum_quantity = -1 WHERE id = $1', [
          itemA,
        ]),
      ),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('low stock is answered from the database', () => {
  it('at the reorder level, not only below it', async () => {
    await owner().query(
      'UPDATE inventory_items SET quantity = 4, minimum_quantity = 4 WHERE id = $1',
      [itemA],
    );

    const { rows } = await asTenant(s.a.id, (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM inventory_items
          WHERE status = 'active' AND quantity <= minimum_quantity`,
      ),
    );

    expect(rows.map((r) => r.id)).toContain(itemA);
  });

  it('an archived item never appears, however empty', async () => {
    await owner().query(
      `UPDATE inventory_items SET quantity = 0, status = 'archived' WHERE id = $1`,
      [itemA],
    );

    const { rows } = await asTenant(s.a.id, (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM inventory_items
          WHERE status = 'active' AND quantity <= minimum_quantity`,
      ),
    );

    expect(rows.map((r) => r.id)).not.toContain(itemA);

    await owner().query(`UPDATE inventory_items SET status = 'active' WHERE id = $1`, [
      itemA,
    ]);
  });
});
