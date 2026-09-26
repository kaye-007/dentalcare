/**
 * 0004 — clinical record integrity
 *
 * The finance tables have been append-only since 0018: a payment is voided,
 * never deleted, and the runtime role cannot do otherwise. The clinical record
 * — legally the more sensitive of the two — had none of that. Anyone holding
 * `clinical:write`, reception included, could hard-delete a procedure, a
 * finding, a perio exam or a note, and nothing recorded that it had existed.
 *
 * This applies the finance pattern to the chart, plus the two things a chart
 * needs that a ledger does not: signing, and an access log.
 *
 * ── Entered in error ──────────────────────────────────────────────────────
 *
 * Seven tables gain (entered_in_error_at, _by, _reason). A wrong entry is
 * withdrawn, not removed: it drops out of the chart, the lists and the counts,
 * and stays in the database with who withdrew it, when and why. The row is
 * then frozen — a trigger refuses every later UPDATE, including a second
 * withdrawal.
 *
 * ── Signing ───────────────────────────────────────────────────────────────
 *
 * clinical_procedures and perio_exams gain (signed_at, signed_by). A signed
 * row cannot be edited at all; the only way to change it is to withdraw it
 * and record it again. A perio exam's readings live in two child tables, so a
 * second trigger refuses readings against a signed or withdrawn exam.
 *
 * ── Billed work ───────────────────────────────────────────────────────────
 *
 * A procedure already on a live invoice cannot have its fee, status, tooth,
 * code or date changed, and cannot be withdrawn. The invoice is what the
 * patient was charged; the procedure is the reason. Letting them diverge
 * silently is how a clinic ends up billing for a filling its own chart says
 * never happened.
 *
 * ── What the runtime role loses ───────────────────────────────────────────
 *
 *   DELETE on every clinical table, and on patients (whose FK cascades would
 *   otherwise reach all of them — referential actions run as the table
 *   owner, not as the caller). A patient is archived, never removed.
 *   UPDATE on patient_notes, except the three withdrawal columns: a note is
 *   written once.
 *
 * The owner role keeps DELETE. Erasure under a data-protection request, or
 * removing a test clinic, remains possible — as a deliberate act by someone
 * holding the migration credentials, which is the point.
 *
 * ── Provenance ────────────────────────────────────────────────────────────
 *
 * tooth_conditions and clinical_procedures gain `source` and `source_detail`.
 * Today every row is 'clinician'. It exists now because the day an imaging
 * model suggests a finding, "who said so" has to be answerable per row, and
 * adding that column to a year of production data is harder than adding it
 * to an empty one.
 *
 * ── The access log ────────────────────────────────────────────────────────
 *
 * patient_access_log records who opened which part of which record. It is
 * append-only exactly as clinic_audit_log is: no UPDATE or DELETE privilege,
 * and a trigger that refuses both even for the owner.
 *
 * Volume is the trade-off. One row per view would be thousands a day in a
 * busy clinic, most of them the same person re-opening the same chart. The
 * service collapses repeat views by the same person of the same resource
 * within five minutes. If that still outgrows a single table, the index below
 * is already (tenant_id, patient_id, accessed_at) — the natural key for
 * monthly range partitioning.
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

/** Tables that gain the withdrawal columns and the record guard. */
const WITHDRAWABLE = [
  'tooth_conditions',
  'clinical_procedures',
  'perio_exams',
  'patient_notes',
  'patient_allergies',
  'patient_conditions',
  'patient_medications',
];

/** Tables the runtime role may no longer DELETE from. */
const NO_DELETE = [
  ...WITHDRAWABLE,
  'perio_measurements',
  'perio_tooth_findings',
  'patients',
];

const withdrawalColumns = (table) => `
ALTER TABLE ${table}
  ADD COLUMN entered_in_error_at     timestamptz,
  ADD COLUMN entered_in_error_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN entered_in_error_reason text,
  ADD CONSTRAINT ${table}_withdrawal_consistent CHECK (
    (entered_in_error_at IS NULL
       AND entered_in_error_by IS NULL
       AND entered_in_error_reason IS NULL)
    OR
    (entered_in_error_at IS NOT NULL
       AND length(btrim(coalesce(entered_in_error_reason, ''))) >= 3)
  );

CREATE TRIGGER ${table}_record_guard
  BEFORE UPDATE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION clinical_record_guard();
`;

const UP = `
-- ── the record guard ─────────────────────────────────────────────────────
-- One function for every withdrawable table. It reads the row as jsonb so it
-- can compare "everything except these columns" without naming each table's
-- columns — a column added to a clinical table later is protected without
-- anyone remembering to extend this.
--
-- SQLSTATE 55000 (object_not_in_prerequisite_state): the services map it to
-- 409 Conflict with the message below, which is written for a person.

CREATE FUNCTION clinical_record_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  withdrawal CONSTANT text[] := ARRAY['entered_in_error_at', 'entered_in_error_by', 'entered_in_error_reason'];
  signing    CONSTANT text[] := ARRAY['signed_at', 'signed_by'];
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  IF old_row->>'entered_in_error_at' IS NOT NULL THEN
    RAISE EXCEPTION 'This entry was withdrawn as entered in error and can no longer change'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF new_row->>'entered_in_error_at' IS NOT NULL THEN
    IF (new_row - withdrawal) IS DISTINCT FROM (old_row - withdrawal) THEN
      RAISE EXCEPTION 'Withdrawing an entry cannot change it at the same time'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;

  IF old_row ? 'signed_at' THEN
    IF old_row->>'signed_at' IS NOT NULL THEN
      RAISE EXCEPTION 'This entry is signed and can no longer be edited. Withdraw it as entered in error and record it again.'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF new_row->>'signed_at' IS NOT NULL
       AND ((new_row - signing) - 'updated_at') IS DISTINCT FROM ((old_row - signing) - 'updated_at') THEN
      RAISE EXCEPTION 'Signing an entry cannot change it at the same time'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  RETURN NEW;
END $$;

-- ── withdrawal columns + guard, per table ────────────────────────────────
${WITHDRAWABLE.map(withdrawalColumns).join('\n')}

-- ── signing ──────────────────────────────────────────────────────────────
ALTER TABLE clinical_procedures
  ADD COLUMN signed_at timestamptz,
  ADD COLUMN signed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT clinical_procedures_signed_when_final
    CHECK (signed_at IS NULL OR status IN ('completed', 'cancelled'));

ALTER TABLE perio_exams
  ADD COLUMN signed_at timestamptz,
  ADD COLUMN signed_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- ── provenance ───────────────────────────────────────────────────────────
ALTER TABLE clinical_procedures
  ADD COLUMN source text NOT NULL DEFAULT 'clinician',
  ADD COLUMN source_detail jsonb,
  ADD CONSTRAINT clinical_procedures_source_known
    CHECK (source IN ('clinician', 'import', 'ai_suggestion'));

ALTER TABLE tooth_conditions
  ADD COLUMN source text NOT NULL DEFAULT 'clinician',
  ADD COLUMN source_detail jsonb,
  ADD CONSTRAINT tooth_conditions_source_known
    CHECK (source IN ('clinician', 'import', 'ai_suggestion'));

-- ── uniqueness ignores withdrawn rows ────────────────────────────────────
-- Otherwise a finding withdrawn as a mistake would block charting the right
-- one, and an allergy entered against the wrong substance spelling would
-- block the correct entry.
DROP INDEX tooth_conditions_active_unique;
CREATE UNIQUE INDEX tooth_conditions_active_unique
  ON tooth_conditions (patient_id, tooth, COALESCE(surface, '*'), condition)
  WHERE status = 'active' AND entered_in_error_at IS NULL;

DROP INDEX patient_allergy_unique;
CREATE UNIQUE INDEX patient_allergy_unique
  ON patient_allergies (patient_id, lower(btrim(substance)))
  WHERE entered_in_error_at IS NULL;

-- ── readings belong to an open exam ──────────────────────────────────────
CREATE FUNCTION perio_exam_children_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  exam record;
BEGIN
  SELECT signed_at, entered_in_error_at INTO exam
    FROM perio_exams WHERE id = NEW.exam_id;
  IF exam.entered_in_error_at IS NOT NULL THEN
    RAISE EXCEPTION 'This periodontal exam was withdrawn as entered in error; its readings can no longer change'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF exam.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This periodontal exam is signed; its readings can no longer change'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER perio_measurements_exam_guard
  BEFORE INSERT OR UPDATE ON perio_measurements
  FOR EACH ROW EXECUTE FUNCTION perio_exam_children_guard();

CREATE TRIGGER perio_tooth_findings_exam_guard
  BEFORE INSERT OR UPDATE ON perio_tooth_findings
  FOR EACH ROW EXECUTE FUNCTION perio_exam_children_guard();

-- ── billed work stays as billed ──────────────────────────────────────────
CREATE FUNCTION clinical_procedure_billing_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ((NEW.fee, NEW.status, NEW.tooth, NEW.surfaces, NEW.procedure_code_id,
       NEW.performed_on, NEW.patient_id)
        IS DISTINCT FROM
      (OLD.fee, OLD.status, OLD.tooth, OLD.surfaces, OLD.procedure_code_id,
       OLD.performed_on, OLD.patient_id)
      OR (OLD.entered_in_error_at IS NULL AND NEW.entered_in_error_at IS NOT NULL))
     AND EXISTS (
       SELECT 1
         FROM invoice_line_items li
         JOIN invoices i ON i.id = li.invoice_id
        WHERE li.procedure_id = OLD.id
          AND i.status <> 'cancelled')
  THEN
    RAISE EXCEPTION 'This procedure is on an invoice. Cancel or adjust the invoice before changing or withdrawing what was billed.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER clinical_procedures_billing_guard
  BEFORE UPDATE ON clinical_procedures
  FOR EACH ROW EXECUTE FUNCTION clinical_procedure_billing_guard();

-- ── the access log ───────────────────────────────────────────────────────
CREATE TABLE patient_access_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id     uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_label    text NOT NULL,
  actor_role     text NOT NULL,
  resource       text NOT NULL,
  accessed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_access_resource_known CHECK (resource IN (
    'record', 'chart', 'procedures', 'perio', 'history',
    'documents', 'document_file', 'treatment_plans', 'billing'))
);

CREATE INDEX patient_access_log_patient_idx
  ON patient_access_log (tenant_id, patient_id, accessed_at DESC);
CREATE INDEX patient_access_log_actor_idx
  ON patient_access_log (tenant_id, actor_user_id, accessed_at DESC);

ALTER TABLE patient_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_access_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_access_log
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE FUNCTION append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER patient_access_log_no_rewrite
  BEFORE UPDATE OR DELETE ON patient_access_log
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER patient_access_log_no_truncate
  BEFORE TRUNCATE ON patient_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();

-- ── grants ───────────────────────────────────────────────────────────────
REVOKE DELETE ON ${NO_DELETE.join(', ')} FROM __APP_USER__;

REVOKE UPDATE ON patient_notes FROM __APP_USER__;
GRANT UPDATE (entered_in_error_at, entered_in_error_by, entered_in_error_reason)
  ON patient_notes TO __APP_USER__;

GRANT SELECT, INSERT ON patient_access_log TO __APP_USER__;
`;

const DOWN = `
DROP TABLE IF EXISTS patient_access_log;
DROP FUNCTION IF EXISTS append_only_guard();

DROP TRIGGER IF EXISTS clinical_procedures_billing_guard ON clinical_procedures;
DROP FUNCTION IF EXISTS clinical_procedure_billing_guard();

DROP TRIGGER IF EXISTS perio_measurements_exam_guard ON perio_measurements;
DROP TRIGGER IF EXISTS perio_tooth_findings_exam_guard ON perio_tooth_findings;
DROP FUNCTION IF EXISTS perio_exam_children_guard();

DROP INDEX patient_allergy_unique;
CREATE UNIQUE INDEX patient_allergy_unique
  ON patient_allergies (patient_id, lower(btrim(substance)));
DROP INDEX tooth_conditions_active_unique;
CREATE UNIQUE INDEX tooth_conditions_active_unique
  ON tooth_conditions (patient_id, tooth, COALESCE(surface, '*'), condition)
  WHERE status = 'active';

ALTER TABLE tooth_conditions
  DROP COLUMN source_detail, DROP COLUMN source;
ALTER TABLE clinical_procedures
  DROP COLUMN source_detail, DROP COLUMN source,
  DROP COLUMN signed_by, DROP COLUMN signed_at;
ALTER TABLE perio_exams DROP COLUMN signed_by, DROP COLUMN signed_at;

${WITHDRAWABLE.map(
  (t) => `DROP TRIGGER IF EXISTS ${t}_record_guard ON ${t};
ALTER TABLE ${t}
  DROP COLUMN entered_in_error_reason,
  DROP COLUMN entered_in_error_by,
  DROP COLUMN entered_in_error_at;`,
).join('\n')}

DROP FUNCTION IF EXISTS clinical_record_guard();

GRANT DELETE ON ${NO_DELETE.join(', ')} TO __APP_USER__;
GRANT UPDATE ON patient_notes TO __APP_USER__;
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

/**
 * Reversible, but not lossless: withdrawn rows come back as ordinary rows,
 * because the columns that said they were withdrawn are gone. Down exists for
 * a development database, not for one with patients in it.
 */
exports.down = (pgm) => {
  pgm.sql(DOWN.replace(/__APP_USER__/g, appUser()));
};
