/**
 * 0020 — lab work, and the labs and suppliers a clinic deals with
 *
 * A crown, a bridge, a denture, an aligner set: work the dentist prepares,
 * a dental laboratory makes, and the clinic fits. Until now DentalCare had no
 * trace of it beyond an expense category called "lab", so the only record
 * that the patient's crown was at the lab, and due Friday, was a notebook at
 * the desk.
 *
 * ── partners ──────────────────────────────────────────────────────────────
 *
 * The laboratories and the material suppliers the clinic works with: a name
 * and a way to reach them. One table with a `kind`, because both are the same
 * thing to the clinic — someone outside it to call, message or pay. A partner
 * is retired (`is_active`), never deleted: past lab work still names it.
 *
 * ── lab_orders ────────────────────────────────────────────────────────────
 *
 * One piece of lab work for one patient. The life of it is a straight line —
 *
 *   preparing → sent → received → fitted        (or cancelled)
 *
 * and each step stamps when it happened, so "at the lab for nine days" and
 * "back, waiting to be fitted" are facts, not guesses. The CHECKs below hold
 * the stamps to the status in both directions the service moves them.
 *
 * `teeth` is FDI, as everywhere else. `cost` is what the lab charges, in the
 * clinic's minor units; it is not an expense by itself — clinics pay labs by
 * monthly statement, and booking each job as an expense would count it twice
 * once the statement is entered.
 *
 * `plan_item_id` ties the work to the treatment plan line it delivers, when
 * there is one. Nothing is deleted: cancelling keeps the row and its reason.
 *
 * ── inventory_items.supplier_id ───────────────────────────────────────────
 *
 * Who the clinic reorders an item from, so "11 items low" can become "message
 * Medident about these four".
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

const rls = (table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${table}
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`;

/** Every FDI tooth number, permanent and deciduous. */
const FDI = [
  ...[1, 2, 3, 4].flatMap((q) => [1, 2, 3, 4, 5, 6, 7, 8].map((t) => q * 10 + t)),
  ...[5, 6, 7, 8].flatMap((q) => [1, 2, 3, 4, 5].map((t) => q * 10 + t)),
].join(',');

const UP = `
-- ── a key the new foreign keys can reference ──────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'treatment_plan_items_id_tenant_key') THEN
    ALTER TABLE treatment_plan_items
      ADD CONSTRAINT treatment_plan_items_id_tenant_key UNIQUE (id, tenant_id);
  END IF;
END $$;

-- ── partners: labs and suppliers ─────────────────────────────────────────
CREATE TABLE partners (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  name        text NOT NULL,
  phone       text,
  email       text,
  notes       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partners_kind_known    CHECK (kind IN ('lab', 'supplier')),
  CONSTRAINT partners_name_present  CHECK (btrim(name) <> ''),
  CONSTRAINT partners_name_sane     CHECK (char_length(name) <= 120),
  CONSTRAINT partners_id_tenant_key UNIQUE (id, tenant_id)
);

-- One "Dental Lab Tirana" per clinic, however it was capitalised when typed.
CREATE UNIQUE INDEX partners_name_unique
  ON partners (tenant_id, kind, lower(btrim(name)));
${rls('partners')}
GRANT SELECT, INSERT, UPDATE ON TABLE partners TO __APP_USER__;

-- ── lab orders ────────────────────────────────────────────────────────────
CREATE TABLE lab_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id    uuid NOT NULL,
  lab_id        uuid,
  dentist_id    uuid,
  plan_item_id  uuid,
  work          text NOT NULL,
  teeth         smallint[] NOT NULL DEFAULT '{}',
  material      text,
  shade         text,
  cost          integer,
  due_on        date,
  status        text NOT NULL DEFAULT 'preparing',
  notes         text,
  sent_at       timestamptz,
  received_at   timestamptz,
  fitted_at     timestamptz,
  cancelled_at  timestamptz,
  cancel_reason text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lab_orders_patient_fk FOREIGN KEY (patient_id, tenant_id)
    REFERENCES patients (id, tenant_id),
  CONSTRAINT lab_orders_lab_fk FOREIGN KEY (lab_id, tenant_id)
    REFERENCES partners (id, tenant_id),
  CONSTRAINT lab_orders_dentist_fk FOREIGN KEY (dentist_id, tenant_id)
    REFERENCES users (id, tenant_id),
  CONSTRAINT lab_orders_plan_item_fk FOREIGN KEY (plan_item_id, tenant_id)
    REFERENCES treatment_plan_items (id, tenant_id),
  CONSTRAINT lab_orders_status_known CHECK (
    status IN ('preparing', 'sent', 'received', 'fitted', 'cancelled')),
  CONSTRAINT lab_orders_work_present CHECK (btrim(work) <> '' AND char_length(work) <= 200),
  CONSTRAINT lab_orders_cost_positive CHECK (cost IS NULL OR cost >= 0),
  CONSTRAINT lab_orders_teeth_fdi CHECK (teeth <@ ARRAY[${FDI}]::smallint[]),
  -- The stamps agree with the status: a job that is at the lab was sent, one
  -- that is back was received, one that is fitted was fitted.
  CONSTRAINT lab_orders_sent_stamped CHECK (
    status NOT IN ('sent', 'received', 'fitted') OR sent_at IS NOT NULL),
  CONSTRAINT lab_orders_received_stamped CHECK (
    status NOT IN ('received', 'fitted') OR received_at IS NOT NULL),
  CONSTRAINT lab_orders_fitted_stamped CHECK (
    (status = 'fitted') = (fitted_at IS NOT NULL)),
  CONSTRAINT lab_orders_cancel_consistent CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (status <> 'cancelled' OR btrim(coalesce(cancel_reason, '')) <> ''))
);

-- The lab list: what is open, by when it is due.
CREATE INDEX lab_orders_open_idx
  ON lab_orders (tenant_id, due_on)
  WHERE status IN ('preparing', 'sent', 'received');
CREATE INDEX lab_orders_patient_idx
  ON lab_orders (tenant_id, patient_id, created_at DESC);
${rls('lab_orders')}
-- No DELETE: a job is cancelled, with its reason, never erased.
GRANT SELECT, INSERT, UPDATE ON TABLE lab_orders TO __APP_USER__;

-- ── who an item is reordered from ─────────────────────────────────────────
ALTER TABLE inventory_items
  ADD COLUMN supplier_id uuid,
  ADD CONSTRAINT inventory_items_supplier_fk FOREIGN KEY (supplier_id, tenant_id)
    REFERENCES partners (id, tenant_id);
`;

const DOWN = `
ALTER TABLE inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_supplier_fk,
  DROP COLUMN IF EXISTS supplier_id;
DROP TABLE IF EXISTS lab_orders;
DROP TABLE IF EXISTS partners;
ALTER TABLE treatment_plan_items DROP CONSTRAINT IF EXISTS treatment_plan_items_id_tenant_key;
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
