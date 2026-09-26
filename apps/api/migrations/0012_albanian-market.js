/**
 * 0012 — the Albanian market: patient messages, ID documents, EUR quotes
 *
 * ── reminders become patient messages ─────────────────────────────────────
 *
 * A row here was an appointment reminder and nothing else: appointment_id NOT
 * NULL, and the patient reached through the appointment. Clinics also send a
 * post-procedure follow-up and an unpaid-balance notice, through the same
 * channels (SMS, WhatsApp, Viber), with the same need for a record of what was
 * sent to whom and whether it arrived. So the table keeps its delivery
 * machinery — claim, lease, retry, receipts — and gains what a message that is
 * not about an appointment needs:
 *
 *   patient_id   who the message went to. Backfilled from the appointment,
 *                then NOT NULL, and kept equal to the appointment's patient
 *                by a trigger whenever there is one.
 *   purpose      appointment_reminder | post_procedure_followup | unpaid_balance
 *   invoice_id   the invoice an unpaid-balance notice was about, when one was
 *
 * appointment_id becomes optional, required only for an appointment reminder.
 * Automatic sending stays reminders-only: a follow-up or a balance notice is
 * always a person's decision.
 *
 * The table keeps its name. Delivery receipts already sent out name this
 * table's ids in their callback URLs, and a rename buys nothing a reader of
 * this comment does not already have.
 *
 * ── patient_documents.kind ────────────────────────────────────────────────
 *
 * 'id_document': a national ID card or passport photographed at the desk.
 *
 * ── patient_access_log.resource ───────────────────────────────────────────
 *
 * 'messages': opening a patient's conversation is a look at their record.
 *
 * ── clinic_settings: a quote currency ─────────────────────────────────────
 *
 * The ledger stays in one currency per clinic (0006). A clinic in lek treating
 * a patient from abroad quotes in euro too, so an estimate can carry a second
 * currency, converted at a rate that is printed on it:
 *
 *   quote_currency  the second currency on estimates, or NULL for none.
 *                   Set to EUR for every clinic that keeps its books in ALL.
 *   fx_rate_source  'live' (the day's published rate) or 'fixed' (the
 *                   clinic's own rate, as many clinics quote tourists)
 *   fx_fixed_rate   clinic-currency units per ONE quote-currency unit, e.g.
 *                   100.50 lek per euro
 *
 * ── fx_rates ──────────────────────────────────────────────────────────────
 *
 * The last published rate fetched for each currency pair, so an estimate can
 * still be printed when the rate provider is unreachable — with the date of
 * the rate it used. Market data, not clinic data: no tenant_id, no RLS.
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

const PURPOSES = `('appointment_reminder','post_procedure_followup','unpaid_balance')`;
const CURRENCIES = `('EUR','ALL','USD','GBP','CHF')`;

const UP = `
-- ── reminders: patient, purpose, invoice ─────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_id_tenant_key') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_id_tenant_key UNIQUE (id, tenant_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_id_tenant_key') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_id_tenant_key UNIQUE (id, tenant_id);
  END IF;
END $$;

ALTER TABLE reminders
  ADD COLUMN patient_id uuid,
  ADD COLUMN purpose text NOT NULL DEFAULT 'appointment_reminder',
  ADD COLUMN invoice_id uuid;

-- FORCE binds the owner too; lift it on both tables for the one statement
-- that has to see every clinic's rows.
ALTER TABLE reminders NO FORCE ROW LEVEL SECURITY;
ALTER TABLE appointments NO FORCE ROW LEVEL SECURITY;
UPDATE reminders r SET patient_id = a.patient_id FROM appointments a WHERE a.id = r.appointment_id;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
ALTER TABLE reminders FORCE ROW LEVEL SECURITY;

ALTER TABLE reminders
  ALTER COLUMN patient_id SET NOT NULL,
  ALTER COLUMN appointment_id DROP NOT NULL,
  ADD CONSTRAINT reminders_patient_fk FOREIGN KEY (patient_id, tenant_id)
    REFERENCES patients (id, tenant_id) ON DELETE CASCADE,
  ADD CONSTRAINT reminders_invoice_fk FOREIGN KEY (invoice_id, tenant_id)
    REFERENCES invoices (id, tenant_id),
  ADD CONSTRAINT reminders_purpose_known CHECK (purpose IN ${PURPOSES}),
  ADD CONSTRAINT reminders_appointment_for_reminder CHECK (
    purpose <> 'appointment_reminder' OR appointment_id IS NOT NULL),
  ADD CONSTRAINT reminders_invoice_for_balance CHECK (
    invoice_id IS NULL OR purpose = 'unpaid_balance'),
  ADD CONSTRAINT reminders_automatic_only_reminders CHECK (
    type <> 'automatic' OR purpose = 'appointment_reminder');

-- A message about an appointment goes to that appointment's patient.
CREATE FUNCTION reminders_patient_matches() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner uuid;
BEGIN
  IF NEW.appointment_id IS NOT NULL THEN
    SELECT patient_id INTO owner FROM appointments WHERE id = NEW.appointment_id;
    IF owner IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'A message about an appointment must go to that appointment''s patient'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reminders_patient_matches
  BEFORE INSERT OR UPDATE OF patient_id, appointment_id ON reminders
  FOR EACH ROW EXECUTE FUNCTION reminders_patient_matches();

-- The conversation view: one patient's messages, newest first.
CREATE INDEX reminders_patient_thread_idx ON reminders (tenant_id, patient_id, created_at DESC);

-- ── documents: identity documents ────────────────────────────────────────
ALTER TABLE patient_documents DROP CONSTRAINT patient_documents_kind_check;
ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_kind_check CHECK (
  kind IN ('xray','photo','consent','referral','insurance','id_document','report','other'));

-- ── access log: the conversation view ────────────────────────────────────
ALTER TABLE patient_access_log DROP CONSTRAINT patient_access_resource_known;
ALTER TABLE patient_access_log ADD CONSTRAINT patient_access_resource_known CHECK (resource IN (
  'record', 'chart', 'procedures', 'perio', 'history',
  'documents', 'document_file', 'treatment_plans', 'billing', 'messages'));

-- ── quote currency ───────────────────────────────────────────────────────
ALTER TABLE clinic_settings
  ADD COLUMN quote_currency text,
  ADD COLUMN fx_rate_source text NOT NULL DEFAULT 'live',
  ADD COLUMN fx_fixed_rate numeric(14,6),
  ADD CONSTRAINT cs_quote_currency_valid CHECK (quote_currency IS NULL OR quote_currency IN ${CURRENCIES}),
  ADD CONSTRAINT cs_quote_currency_differs CHECK (quote_currency IS NULL OR quote_currency <> currency),
  ADD CONSTRAINT cs_fx_rate_source_known CHECK (fx_rate_source IN ('live','fixed')),
  ADD CONSTRAINT cs_fx_fixed_rate_positive CHECK (fx_fixed_rate IS NULL OR fx_fixed_rate > 0),
  ADD CONSTRAINT cs_fx_fixed_rate_present CHECK (fx_rate_source <> 'fixed' OR fx_fixed_rate IS NOT NULL);

ALTER TABLE clinic_settings NO FORCE ROW LEVEL SECURITY;
UPDATE clinic_settings SET quote_currency = 'EUR' WHERE currency = 'ALL';
ALTER TABLE clinic_settings FORCE ROW LEVEL SECURITY;

-- ── published rates ──────────────────────────────────────────────────────
CREATE TABLE fx_rates (
  base        text NOT NULL,
  quote       text NOT NULL,
  -- base-currency units per ONE quote-currency unit
  rate        numeric(18,8) NOT NULL,
  source      text NOT NULL,
  as_of       date NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base, quote),
  CONSTRAINT fx_rates_currencies CHECK (base IN ${CURRENCIES} AND quote IN ${CURRENCIES} AND base <> quote),
  CONSTRAINT fx_rates_positive CHECK (rate > 0)
);

GRANT SELECT, INSERT, UPDATE ON TABLE fx_rates TO __APP_USER__;
`;

const DOWN = `
DROP TABLE IF EXISTS fx_rates;

ALTER TABLE clinic_settings
  DROP CONSTRAINT IF EXISTS cs_fx_fixed_rate_present,
  DROP CONSTRAINT IF EXISTS cs_fx_fixed_rate_positive,
  DROP CONSTRAINT IF EXISTS cs_fx_rate_source_known,
  DROP CONSTRAINT IF EXISTS cs_quote_currency_differs,
  DROP CONSTRAINT IF EXISTS cs_quote_currency_valid,
  DROP COLUMN IF EXISTS fx_fixed_rate,
  DROP COLUMN IF EXISTS fx_rate_source,
  DROP COLUMN IF EXISTS quote_currency;

-- An identity document cannot be expressed before this migration; it becomes
-- 'other' rather than blocking the rollback.
ALTER TABLE patient_documents NO FORCE ROW LEVEL SECURITY;
UPDATE patient_documents SET kind = 'other' WHERE kind = 'id_document';
ALTER TABLE patient_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE patient_documents DROP CONSTRAINT patient_documents_kind_check;
ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_kind_check CHECK (
  kind IN ('xray','photo','consent','referral','insurance','report','other'));

-- The access log is append-only evidence; rows naming 'messages' stay as they
-- are, and the older rule applies to new rows only.
ALTER TABLE patient_access_log DROP CONSTRAINT patient_access_resource_known;
ALTER TABLE patient_access_log ADD CONSTRAINT patient_access_resource_known CHECK (resource IN (
  'record', 'chart', 'procedures', 'perio', 'history',
  'documents', 'document_file', 'treatment_plans', 'billing')) NOT VALID;

DROP INDEX IF EXISTS reminders_patient_thread_idx;
DROP TRIGGER IF EXISTS reminders_patient_matches ON reminders;
DROP FUNCTION IF EXISTS reminders_patient_matches();

DO $$
BEGIN
  ALTER TABLE reminders NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM reminders WHERE appointment_id IS NULL) THEN
    RAISE EXCEPTION 'Patient messages that are not appointment reminders exist; rolling back 0012 would delete the record of them.';
  END IF;
  ALTER TABLE reminders FORCE ROW LEVEL SECURITY;
END $$;

ALTER TABLE reminders
  DROP CONSTRAINT IF EXISTS reminders_automatic_only_reminders,
  DROP CONSTRAINT IF EXISTS reminders_invoice_for_balance,
  DROP CONSTRAINT IF EXISTS reminders_appointment_for_reminder,
  DROP CONSTRAINT IF EXISTS reminders_purpose_known,
  DROP CONSTRAINT IF EXISTS reminders_invoice_fk,
  DROP CONSTRAINT IF EXISTS reminders_patient_fk,
  ALTER COLUMN appointment_id SET NOT NULL,
  DROP COLUMN IF EXISTS invoice_id,
  DROP COLUMN IF EXISTS purpose,
  DROP COLUMN IF EXISTS patient_id;
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
