/**
 * 0009 — running a clinic: profile, calendar, channels, import and photos
 *
 * ── clinic_settings ───────────────────────────────────────────────────────
 *
 *   legal_name, registration_number, website   what an invoice has to print
 *   brand_color, logo_storage_key               the clinic's own mark; the
 *                                               logo lives in the private
 *                                               bucket, never a public URL
 *   invoice_prefix                              "INV-" unless the clinic says
 *                                               otherwise; applied to NEW
 *                                               invoices only
 *   payment_methods                             the clinic's own names for
 *                                               how it is paid ("POS Credins")
 *                                               each mapped to cash|card|bank,
 *                                               which is what billing and the
 *                                               tax authority understand
 *   reminder_channel                            sms | whatsapp_business | viber
 *   reminder_hours_before                       now 12 or 24 and nothing else.
 *                                               Existing values are moved to
 *                                               the nearer of the two.
 *
 * ── schedule_closures ─────────────────────────────────────────────────────
 *
 * Days the clinic is shut (staff_id NULL: a public holiday, a closure) or one
 * clinician is away (staff_id set: leave, a course). The weekly shift pattern
 * stays in staff_availability; this is the calendar of exceptions to it.
 *
 * ── patients ──────────────────────────────────────────────────────────────
 *
 *   national_id        Albanian personal number or any national identifier;
 *                      unique per clinic, compared without case or spaces,
 *                      and the strongest duplicate signal an import has
 *   preferred_channel  a patient's own choice of reminder channel
 *   photo_document_id  the profile picture, which is a patient document like
 *                      any other (private bucket, access-logged)
 *   import_batch_id    which import created the record
 *
 * ── patient_imports ───────────────────────────────────────────────────────
 *
 * One row per committed import batch: who, from which file, how many rows.
 * Append-only for the runtime role.
 *
 * ── patient_documents.photo_tag ───────────────────────────────────────────
 *
 * before | after | progress, on photos only.
 *
 * ── payments.method_label, reminders.template_values ─────────────────────
 *
 * The clinic's name for the method a payment was taken by, and the values a
 * WhatsApp template is filled with — kept on the row so a retry sends what
 * the first attempt would have.
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

const CHANNELS = `('sms','whatsapp_business','viber')`;

const UP = `
-- ── keys composite foreign keys point at ─────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_id_tenant_key') THEN
    ALTER TABLE users ADD CONSTRAINT users_id_tenant_key UNIQUE (id, tenant_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_documents_id_tenant_key') THEN
    ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_id_tenant_key UNIQUE (id, tenant_id);
  END IF;
END $$;

-- ── clinic profile, finance and reminder channel ─────────────────────────
ALTER TABLE clinic_settings
  ADD COLUMN legal_name text,
  ADD COLUMN registration_number text,
  ADD COLUMN website text,
  ADD COLUMN brand_color text,
  ADD COLUMN logo_storage_key text,
  ADD COLUMN logo_updated_at timestamptz,
  ADD COLUMN invoice_prefix text NOT NULL DEFAULT 'INV-',
  ADD COLUMN payment_methods jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN reminder_channel text NOT NULL DEFAULT 'sms',
  ADD CONSTRAINT cs_brand_color_hex CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT cs_invoice_prefix_valid CHECK (invoice_prefix ~ '^[A-Za-z0-9/_.-]{0,12}$'),
  ADD CONSTRAINT cs_payment_methods_array CHECK (jsonb_typeof(payment_methods) = 'array'),
  ADD CONSTRAINT cs_reminder_channel_known CHECK (reminder_channel IN ${CHANNELS}),
  ADD CONSTRAINT cs_logo_consistent CHECK ((logo_storage_key IS NULL) = (logo_updated_at IS NULL));

-- 12 or 24 hours. FORCE binds the owner too; lift it for the one statement
-- that has to see every clinic's row.
ALTER TABLE clinic_settings NO FORCE ROW LEVEL SECURITY;
UPDATE clinic_settings
   SET reminder_hours_before = CASE WHEN reminder_hours_before <= 18 THEN 12 ELSE 24 END
 WHERE reminder_hours_before NOT IN (12, 24);
ALTER TABLE clinic_settings FORCE ROW LEVEL SECURITY;

ALTER TABLE clinic_settings
  DROP CONSTRAINT cs_reminder_hours_valid,
  ADD CONSTRAINT cs_reminder_hours_valid CHECK (reminder_hours_before IN (12, 24));

-- ── holidays and time off ────────────────────────────────────────────────
CREATE TABLE schedule_closures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id    uuid,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  reason      text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_closures_staff_fk FOREIGN KEY (staff_id, tenant_id)
    REFERENCES users (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT schedule_closures_range CHECK (ends_on >= starts_on),
  CONSTRAINT schedule_closures_span CHECK (ends_on - starts_on <= 366),
  CONSTRAINT schedule_closures_reason_present CHECK (btrim(reason) <> '')
);

CREATE INDEX schedule_closures_range_idx
  ON schedule_closures (tenant_id, starts_on, ends_on);

ALTER TABLE schedule_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_closures FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schedule_closures
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- A closure is configuration, not evidence: it can be removed.
GRANT SELECT, INSERT, DELETE ON TABLE schedule_closures TO __APP_USER__;

-- ── patient imports ──────────────────────────────────────────────────────
CREATE TABLE patient_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_name       text NOT NULL,
  source_label    text,
  rows_received   integer NOT NULL,
  rows_imported   integer NOT NULL,
  rows_skipped    integer NOT NULL,
  balances_total  integer NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_imports_counts_sane CHECK (
    rows_received >= 0 AND rows_imported >= 0 AND rows_skipped >= 0
    AND rows_imported + rows_skipped <= rows_received),
  CONSTRAINT patient_imports_file_present CHECK (btrim(file_name) <> '')
);

CREATE UNIQUE INDEX patient_imports_id_tenant_key ON patient_imports (id, tenant_id);

ALTER TABLE patient_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_imports FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_imports
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT ON TABLE patient_imports TO __APP_USER__;

-- ── patients ─────────────────────────────────────────────────────────────
ALTER TABLE patients
  ADD COLUMN national_id text,
  ADD COLUMN preferred_channel text,
  ADD COLUMN photo_document_id uuid,
  ADD COLUMN import_batch_id uuid,
  ADD CONSTRAINT patients_national_id_present CHECK (national_id IS NULL OR btrim(national_id) <> ''),
  ADD CONSTRAINT patients_preferred_channel_known CHECK (
    preferred_channel IS NULL OR preferred_channel IN ${CHANNELS}),
  ADD CONSTRAINT patients_photo_fk FOREIGN KEY (photo_document_id, tenant_id)
    REFERENCES patient_documents (id, tenant_id),
  ADD CONSTRAINT patients_import_fk FOREIGN KEY (import_batch_id, tenant_id)
    REFERENCES patient_imports (id, tenant_id);

-- One person, one record: the identifier compared the way people type it.
CREATE UNIQUE INDEX patients_national_id_unique
  ON patients (tenant_id, upper(regexp_replace(national_id, '\\s', '', 'g')))
  WHERE national_id IS NOT NULL;

-- ── documents ────────────────────────────────────────────────────────────
ALTER TABLE patient_documents
  ADD COLUMN photo_tag text,
  ADD CONSTRAINT document_photo_tag_known CHECK (
    photo_tag IS NULL OR (photo_tag IN ('before','after','progress') AND kind = 'photo'));

-- ── payments and reminders ───────────────────────────────────────────────
ALTER TABLE payments
  ADD COLUMN method_label text,
  ADD CONSTRAINT payments_method_label_sane CHECK (
    method_label IS NULL OR char_length(btrim(method_label)) BETWEEN 1 AND 60);

ALTER TABLE reminders
  ADD COLUMN template_values jsonb;
`;

const DOWN = `
ALTER TABLE reminders DROP COLUMN IF EXISTS template_values;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_method_label_sane,
  DROP COLUMN IF EXISTS method_label;

ALTER TABLE patient_documents
  DROP CONSTRAINT IF EXISTS document_photo_tag_known,
  DROP COLUMN IF EXISTS photo_tag;

DROP INDEX IF EXISTS patients_national_id_unique;
ALTER TABLE patients
  DROP CONSTRAINT IF EXISTS patients_import_fk,
  DROP CONSTRAINT IF EXISTS patients_photo_fk,
  DROP CONSTRAINT IF EXISTS patients_preferred_channel_known,
  DROP CONSTRAINT IF EXISTS patients_national_id_present,
  DROP COLUMN IF EXISTS import_batch_id,
  DROP COLUMN IF EXISTS photo_document_id,
  DROP COLUMN IF EXISTS preferred_channel,
  DROP COLUMN IF EXISTS national_id;

DROP TABLE IF EXISTS patient_imports;
DROP TABLE IF EXISTS schedule_closures;

ALTER TABLE clinic_settings
  DROP CONSTRAINT cs_reminder_hours_valid,
  ADD CONSTRAINT cs_reminder_hours_valid CHECK (reminder_hours_before BETWEEN 1 AND 168);

ALTER TABLE clinic_settings
  DROP CONSTRAINT IF EXISTS cs_logo_consistent,
  DROP CONSTRAINT IF EXISTS cs_reminder_channel_known,
  DROP CONSTRAINT IF EXISTS cs_payment_methods_array,
  DROP CONSTRAINT IF EXISTS cs_invoice_prefix_valid,
  DROP CONSTRAINT IF EXISTS cs_brand_color_hex,
  DROP COLUMN IF EXISTS reminder_channel,
  DROP COLUMN IF EXISTS payment_methods,
  DROP COLUMN IF EXISTS invoice_prefix,
  DROP COLUMN IF EXISTS logo_updated_at,
  DROP COLUMN IF EXISTS logo_storage_key,
  DROP COLUMN IF EXISTS brand_color,
  DROP COLUMN IF EXISTS website,
  DROP COLUMN IF EXISTS registration_number,
  DROP COLUMN IF EXISTS legal_name;

ALTER TABLE patient_documents DROP CONSTRAINT IF EXISTS patient_documents_id_tenant_key;
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
