/**
 * 0007 — inventory lots, expiry and traceability
 *
 * Until now a box of anaesthetic was a number on a shelf. That is enough for
 * gloves and not enough for anything that expires or can be recalled: a
 * clinic could not say which cartridges expire next month, and when a
 * manufacturer recalled a batch it could not say which patients received it.
 *
 * ── The shape ─────────────────────────────────────────────────────────────
 *
 *   inventory_items.track_lots   opt-in, per item. Gloves stay a single
 *                                number; anaesthetic, composite and implants
 *                                are tracked by lot.
 *   inventory_lots               one row per lot of one item: the number on
 *                                the packaging, its expiry date, and how much
 *                                of it is on the shelf.
 *   stock_movements.lot_id       which lot a movement touched, with
 *                                lot_quantity_after beside quantity_after so a
 *                                lot's history reconciles the way an item's
 *                                already does.
 *   stock_movements.patient_id   who received it, and procedure_id what it was
 *                                used for. Usage only.
 *
 * ── What the database holds true ──────────────────────────────────────────
 *
 *   An item's quantity is the sum of its lots, for a lot-tracked item. A
 *   deferred constraint trigger checks it at COMMIT, so the service can move a
 *   lot and its item in either order inside one transaction, and no
 *   transaction can end with the two disagreeing.
 *
 *   A movement of a lot-tracked item names its lot.
 *
 *   A movement's lot belongs to its item, and both to the clinic: a composite
 *   foreign key (lot_id, item_id, tenant_id). The same shape ties a lot to its
 *   item and a movement to its patient and procedure, so an id from another
 *   clinic cannot be referenced even by code that skipped the service's
 *   RLS-scoped lookups — a plain foreign key check ignores RLS.
 *
 *   A recalled lot is never used on a patient or restocked, and never
 *   un-recalled. It can still be written off or counted: the stock is
 *   physically on the shelf until somebody removes it.
 *
 *   A lot's identity is fixed. The runtime role may UPDATE only its quantity
 *   and the recall columns, and holds no DELETE at all.
 *
 * ── Trade-offs taken ──────────────────────────────────────────────────────
 *
 *   Expiry is a date, and a lot is expired from the day after it. The service
 *   compares against the database's CURRENT_DATE rather than any browser's
 *   clock, so every screen agrees. A clinic far from the database's timezone
 *   could see a lot turn over a few hours early or late; that is why refusing
 *   an expired lot is the service's job, where it is explained, and not a
 *   trigger's, where that edge would become a hard error.
 *
 *   The reorder level stays per item. Nobody reorders a lot.
 */

exports.shorthands = undefined;

/** The runtime role. Configurable for the same reason the baseline is. */
const appUser = () => process.env.APP_DB_USER || 'app_user';

const UP = `
-- ── keys the composite foreign keys below point at ──────────────────────
ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE patients
  ADD CONSTRAINT patients_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE clinical_procedures
  ADD CONSTRAINT clinical_procedures_id_tenant_key UNIQUE (id, tenant_id);

-- ── per-item switch ─────────────────────────────────────────────────────
ALTER TABLE inventory_items
  ADD COLUMN track_lots boolean NOT NULL DEFAULT false,
  ADD COLUMN expiry_warning_days integer NOT NULL DEFAULT 60,
  ADD CONSTRAINT inventory_expiry_warning_sane CHECK (expiry_warning_days BETWEEN 0 AND 730);

-- ── lots ────────────────────────────────────────────────────────────────
CREATE TABLE inventory_lots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id        uuid NOT NULL,
  lot_number     text NOT NULL,
  expires_on     date,
  quantity       numeric(12,2) NOT NULL DEFAULT 0,
  received_on    date NOT NULL DEFAULT CURRENT_DATE,
  status         text NOT NULL DEFAULT 'active',
  recalled_at    timestamptz,
  recalled_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  recall_reason  text,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_lots_item_fk FOREIGN KEY (item_id, tenant_id)
    REFERENCES inventory_items (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT inventory_lots_identity UNIQUE (id, item_id, tenant_id),
  CONSTRAINT inventory_lot_number_present   CHECK (btrim(lot_number) <> ''),
  CONSTRAINT inventory_lot_quantity_positive CHECK (quantity >= 0),
  CONSTRAINT inventory_lot_status_known     CHECK (status IN ('active','recalled')),
  CONSTRAINT inventory_lot_recall_consistent CHECK (
    (status = 'recalled') = (recalled_at IS NOT NULL)
    AND (status <> 'recalled' OR length(btrim(coalesce(recall_reason, ''))) >= 3)
  )
);

-- One "A123" per item, however it was capitalised or padded when typed.
CREATE UNIQUE INDEX inventory_lot_number_unique
  ON inventory_lots (tenant_id, item_id, lower(btrim(lot_number)));

CREATE INDEX inventory_lots_item_idx
  ON inventory_lots (tenant_id, item_id);

-- "What expires soon" is asked on every dashboard load.
CREATE INDEX inventory_lots_expiry_idx
  ON inventory_lots (tenant_id, expires_on)
  WHERE quantity > 0 AND expires_on IS NOT NULL;

-- ── movements learn their lot, patient and procedure ────────────────────
ALTER TABLE stock_movements
  ADD COLUMN lot_id             uuid,
  ADD COLUMN lot_quantity_after numeric(12,2),
  ADD COLUMN patient_id         uuid,
  ADD COLUMN procedure_id       uuid,
  ADD CONSTRAINT stock_movement_lot_fk FOREIGN KEY (lot_id, item_id, tenant_id)
    REFERENCES inventory_lots (id, item_id, tenant_id),
  ADD CONSTRAINT stock_movement_patient_fk FOREIGN KEY (patient_id, tenant_id)
    REFERENCES patients (id, tenant_id),
  ADD CONSTRAINT stock_movement_procedure_fk FOREIGN KEY (procedure_id, tenant_id)
    REFERENCES clinical_procedures (id, tenant_id),
  ADD CONSTRAINT stock_movement_lot_after_with_lot
    CHECK ((lot_id IS NULL) = (lot_quantity_after IS NULL)),
  ADD CONSTRAINT stock_movement_lot_after_positive
    CHECK (lot_quantity_after IS NULL OR lot_quantity_after >= 0),
  ADD CONSTRAINT stock_movement_patient_only_on_usage
    CHECK ((patient_id IS NULL AND procedure_id IS NULL) OR kind = 'usage'),
  ADD CONSTRAINT stock_movement_procedure_needs_patient
    CHECK (procedure_id IS NULL OR patient_id IS NOT NULL);

CREATE INDEX stock_movements_lot_idx
  ON stock_movements (tenant_id, lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX stock_movements_patient_idx
  ON stock_movements (tenant_id, patient_id) WHERE patient_id IS NOT NULL;

-- ── invariants ──────────────────────────────────────────────────────────

-- Runs at COMMIT. Both branches are separate statements on purpose: a CASE
-- naming NEW.item_id would fail to prepare on inventory_items, which has no
-- such column, even when that branch is never taken.
CREATE FUNCTION inventory_lot_balance_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_item     uuid;
  v_tracked  boolean;
  v_quantity numeric;
  v_lots     numeric;
  v_count    integer;
BEGIN
  IF TG_TABLE_NAME = 'inventory_items' THEN
    v_item := NEW.id;
  ELSE
    v_item := NEW.item_id;
  END IF;

  SELECT track_lots, quantity INTO v_tracked, v_quantity
    FROM inventory_items WHERE id = v_item;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(quantity), 0), count(*) INTO v_lots, v_count
    FROM inventory_lots WHERE item_id = v_item;

  IF v_tracked AND v_quantity <> v_lots THEN
    RAISE EXCEPTION 'Stock of this item (%) does not match the sum of its lots (%)', v_quantity, v_lots
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_tracked AND v_count > 0 THEN
    RAISE EXCEPTION 'Lots are recorded against an item that does not track lots'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER inventory_items_lot_balance
  AFTER INSERT OR UPDATE OF quantity, track_lots ON inventory_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory_lot_balance_check();

CREATE CONSTRAINT TRIGGER inventory_lots_balance
  AFTER INSERT OR UPDATE OF quantity ON inventory_lots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory_lot_balance_check();

CREATE FUNCTION stock_movement_lot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lot_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM inventory_items WHERE id = NEW.item_id AND track_lots) THEN
      RAISE EXCEPTION 'A movement of a lot-tracked item must name its lot'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind IN ('usage', 'receipt') AND EXISTS (
          SELECT 1 FROM inventory_lots WHERE id = NEW.lot_id AND status = 'recalled') THEN
    RAISE EXCEPTION 'That lot has been recalled: it can be written off or counted, not used or restocked'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stock_movements_lot_guard
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movement_lot_guard();

CREATE FUNCTION inventory_lot_recall_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'recalled' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.recalled_at IS DISTINCT FROM OLD.recalled_at
    OR NEW.recalled_by IS DISTINCT FROM OLD.recalled_by
    OR NEW.recall_reason IS DISTINCT FROM OLD.recall_reason) THEN
    RAISE EXCEPTION 'A recall is permanent, and its record cannot be rewritten'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inventory_lots_recall_guard
  BEFORE UPDATE ON inventory_lots
  FOR EACH ROW EXECUTE FUNCTION inventory_lot_recall_guard();

-- ── isolation ───────────────────────────────────────────────────────────
ALTER TABLE inventory_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_lots FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inventory_lots
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ── grants ──────────────────────────────────────────────────────────────
-- No DELETE: a lot that patients received is evidence. UPDATE only on what
-- legitimately changes; the number, item and expiry are what was received.
GRANT SELECT, INSERT ON TABLE inventory_lots TO __APP_USER__;
GRANT UPDATE (quantity, status, recalled_at, recalled_by, recall_reason, updated_at)
  ON TABLE inventory_lots TO __APP_USER__;
`;

const DOWN = `
ALTER TABLE inventory_lots NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_lots) THEN
    RAISE EXCEPTION 'Lots are recorded; rolling back 0007 would lose which patients received them.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS stock_movements_lot_guard ON stock_movements;
DROP FUNCTION IF EXISTS stock_movement_lot_guard();
DROP TRIGGER IF EXISTS inventory_items_lot_balance ON inventory_items;
DROP TRIGGER IF EXISTS inventory_lots_balance ON inventory_lots;
DROP FUNCTION IF EXISTS inventory_lot_balance_check();
DROP TRIGGER IF EXISTS inventory_lots_recall_guard ON inventory_lots;
DROP FUNCTION IF EXISTS inventory_lot_recall_guard();

DROP INDEX IF EXISTS stock_movements_patient_idx;
DROP INDEX IF EXISTS stock_movements_lot_idx;
ALTER TABLE stock_movements
  DROP CONSTRAINT IF EXISTS stock_movement_procedure_needs_patient,
  DROP CONSTRAINT IF EXISTS stock_movement_patient_only_on_usage,
  DROP CONSTRAINT IF EXISTS stock_movement_lot_after_positive,
  DROP CONSTRAINT IF EXISTS stock_movement_lot_after_with_lot,
  DROP CONSTRAINT IF EXISTS stock_movement_procedure_fk,
  DROP CONSTRAINT IF EXISTS stock_movement_patient_fk,
  DROP CONSTRAINT IF EXISTS stock_movement_lot_fk,
  DROP COLUMN IF EXISTS procedure_id,
  DROP COLUMN IF EXISTS patient_id,
  DROP COLUMN IF EXISTS lot_quantity_after,
  DROP COLUMN IF EXISTS lot_id;

DROP TABLE IF EXISTS inventory_lots;

ALTER TABLE inventory_items
  DROP CONSTRAINT IF EXISTS inventory_expiry_warning_sane,
  DROP COLUMN IF EXISTS expiry_warning_days,
  DROP COLUMN IF EXISTS track_lots;

ALTER TABLE clinical_procedures DROP CONSTRAINT IF EXISTS clinical_procedures_id_tenant_key;
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_id_tenant_key;
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_id_tenant_key;
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
