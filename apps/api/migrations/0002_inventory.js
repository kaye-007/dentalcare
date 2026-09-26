/**
 * 0002 — inventory
 *
 * Materials and supplies: what is on the shelf, what the floor is, and every
 * movement in or out.
 *
 * ── The shape, and why ────────────────────────────────────────────────────
 *
 * Two tables, and the split is the whole design.
 *
 *   inventory_items    the current state. One row per thing a clinic stocks,
 *                      carrying the running `quantity` and the
 *                      `minimum_quantity` that defines "low".
 *
 *   stock_movements    how it got there. Append-only. Every change to a
 *                      quantity is a row, signed, with the resulting total
 *                      recorded alongside it.
 *
 * The running total could be derived by summing movements instead of stored,
 * and that would be one fewer thing to keep true. It is stored because "which
 * items are low" is the question this module exists to answer, it is asked on
 * every dashboard load, and answering it from a sum over history means a
 * GROUP BY across the whole table to render one badge. The service holds the
 * two in step inside a single transaction with `SELECT ... FOR UPDATE`, and
 * `quantity_after` on every movement means the stored total can always be
 * reconciled against the history rather than merely trusted.
 *
 * ── What the database refuses ─────────────────────────────────────────────
 *
 * The same reasoning as payments in 0018: reception must be able to correct a
 * mistake and must not be able to erase one.
 *
 *   no DELETE on stock_movements   a wrong movement is corrected by an
 *                                  opposing movement, which leaves both on
 *                                  the record. The grant is withheld from the
 *                                  runtime role, so no controller bug can
 *                                  reach it.
 *   no UPDATE on stock_movements   history does not get edited.
 *   no DELETE on inventory_items   an item is archived, never removed — its
 *                                  movements are a record of real consumption
 *                                  and would go with it.
 *
 *   direction matches kind         a movement called `usage` cannot add
 *                                  stock, and a `receipt` cannot remove it.
 *                                  Only `adjustment` may go either way, which
 *                                  is what makes it the honest name for a
 *                                  stock count that disagreed with the
 *                                  system. Enforced by CHECK, so it holds
 *                                  whatever the application believes.
 *
 *   quantity >= 0                  on the item and on every movement's
 *                                  resulting total. A clinic cannot hold
 *                                  minus three boxes of gloves, and a bug
 *                                  that tries fails loudly at the write
 *                                  rather than quietly at the next stock
 *                                  count.
 *
 * RLS is ENABLE *and* FORCE with the same transaction-local policy as every
 * other tenant table, and grants are explicit per table — the baseline's
 * header explains at length why there is no blanket grant and no default ACL.
 */

exports.shorthands = undefined;

/** The runtime role. Configurable for the same reason the baseline is. */
const appUser = () => process.env.APP_DB_USER || 'app_user';

const UP = `
CREATE TABLE inventory_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  category         text,
  unit             text NOT NULL DEFAULT 'unit',
  quantity         numeric(12,2) NOT NULL DEFAULT 0,
  minimum_quantity numeric(12,2) NOT NULL DEFAULT 0,
  notes            text,
  status           text NOT NULL DEFAULT 'active',
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_item_name_present    CHECK (btrim(name) <> ''),
  CONSTRAINT inventory_item_unit_present    CHECK (btrim(unit) <> ''),
  CONSTRAINT inventory_quantity_positive    CHECK (quantity >= 0),
  CONSTRAINT inventory_minimum_positive     CHECK (minimum_quantity >= 0),
  CONSTRAINT inventory_item_status_known    CHECK (status IN ('active','archived'))
);

-- One "Composite" per clinic, however it was capitalised or padded when typed.
CREATE UNIQUE INDEX inventory_item_name_unique
  ON inventory_items (tenant_id, lower(btrim(name)));

-- The dashboard badge, answered from an index rather than a scan. A partial
-- index may compare two columns of its own row, which is exactly what "low"
-- means here.
CREATE INDEX inventory_items_low_stock_idx
  ON inventory_items (tenant_id)
  WHERE status = 'active' AND quantity <= minimum_quantity;

CREATE INDEX inventory_items_tenant_status_idx
  ON inventory_items (tenant_id, status);

CREATE TABLE stock_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id         uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  quantity_delta  numeric(12,2) NOT NULL,
  quantity_after  numeric(12,2) NOT NULL,
  reason          text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_movement_kind_known CHECK (
    kind IN ('receipt','usage','adjustment','write_off')
  ),
  CONSTRAINT stock_movement_delta_nonzero    CHECK (quantity_delta <> 0),
  CONSTRAINT stock_movement_after_positive   CHECK (quantity_after >= 0),
  -- A movement's name has to match what it does. 'adjustment' is the only
  -- kind allowed to go either way, which is what makes it the right name for
  -- reconciling a physical stock count.
  CONSTRAINT stock_movement_direction CHECK (
    (kind = 'receipt'   AND quantity_delta > 0) OR
    (kind = 'usage'     AND quantity_delta < 0) OR
    (kind = 'write_off' AND quantity_delta < 0) OR
    (kind = 'adjustment')
  )
);

CREATE INDEX stock_movements_item_idx
  ON stock_movements (tenant_id, item_id, created_at DESC);

CREATE INDEX stock_movements_recent_idx
  ON stock_movements (tenant_id, created_at DESC);

-- ── isolation ────────────────────────────────────────────────────────────
-- ENABLE *and* FORCE: without FORCE the table owner is exempt, and on a
-- deployment where the API and the migrations share a role that exemption is
-- the whole isolation model gone.

ALTER TABLE inventory_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items  FORCE  ROW LEVEL SECURITY;
ALTER TABLE stock_movements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements  FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inventory_items
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON stock_movements
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ── grants ───────────────────────────────────────────────────────────────
-- Explicit, per table, never ON ALL TABLES and never a default ACL.
--
-- inventory_items has no DELETE: an item is archived. Its movements are a
-- record of what the clinic actually consumed, and deleting the item would
-- cascade them away.
--
-- stock_movements has neither UPDATE nor DELETE, for the same reason payments
-- do not: a wrong movement is corrected by an opposing one, and both stay.

GRANT SELECT, INSERT, UPDATE ON TABLE inventory_items TO __APP_USER__;
GRANT SELECT, INSERT         ON TABLE stock_movements TO __APP_USER__;
`;

const DOWN = `
DROP TABLE IF EXISTS stock_movements;
DROP TABLE IF EXISTS inventory_items;
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

/**
 * Reversible, and it really does reverse: the two tables are new here, nothing
 * else references them, and dropping them returns the schema to 0001 exactly.
 * Verified up-down-up like every migration in this repository.
 */
exports.down = (pgm) => {
  pgm.sql(DOWN);
};
