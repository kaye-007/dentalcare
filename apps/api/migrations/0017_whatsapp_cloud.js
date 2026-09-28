/**
 * 0017 — WhatsApp appointment reminders, from each clinic's own number
 *
 * Until now WhatsApp went out through one Twilio sender configured for the
 * whole deployment. Here each clinic connects its own WhatsApp Business
 * Cloud API account, and a receptionist sends tomorrow's reminders by hand:
 * pick the eligible patients, preview, confirm.
 *
 * ── The access token ──────────────────────────────────────────────────────
 *
 * `encrypted_access_token` is AES-256-GCM ciphertext (core/mfa/secret-box),
 * sealed with WHATSAPP_ENCRYPTION_KEYS and bound to the clinic, so a row
 * copied onto another clinic fails to open. The key never touches the
 * database. The token is never selected by any read the API answers with.
 *
 * ── One reminder per appointment ─────────────────────────────────────────
 *
 * `whatsapp_message_sends_one_live` is the duplicate guard: one live send
 * (queued, sending, accepted, sent) per clinic, appointment, patient and kind
 * of reminder. Two tabs or a double click race to insert, one wins, the other
 * records `already_sent`. The template is deliberately NOT part of the key —
 * switching templates must not remind the same patient twice. A failed or
 * skipped attempt does not hold the slot, so it can be tried again.
 *
 * ── Consent ───────────────────────────────────────────────────────────────
 *
 * A patient is reminded on WhatsApp only with recorded consent: when, and how
 * it was given. Opting out stays where it always was, `reminders_opt_out`
 * (0008) — WhatsApp is now the only reminder channel, and two opt-out flags
 * would one day disagree.
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

const rls = (table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${table}
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`;

const E164 = `'^\\+[1-9][0-9]{7,14}$'`;

const UP = `
-- ── the old reminder path goes quiet ───────────────────────────────────────
-- WhatsApp from the clinic's own number is now the one way to remind a
-- patient. The automatic scheduler (SMS, Viber, the shared Twilio sender, or
-- the internal log) acts only for clinics with reminders_enabled, so turning
-- that off everywhere stops it without deleting it.
UPDATE clinic_settings SET reminders_enabled = false WHERE reminders_enabled;

-- ── patients: consent ──────────────────────────────────────────────────────
ALTER TABLE patients
  ADD COLUMN whatsapp_phone_e164     text,
  ADD COLUMN whatsapp_opt_in         boolean NOT NULL DEFAULT false,
  ADD COLUMN whatsapp_opted_in_at    timestamptz,
  ADD COLUMN whatsapp_opt_in_source  text,
  ADD CONSTRAINT patients_whatsapp_phone_e164 CHECK (whatsapp_phone_e164 IS NULL OR whatsapp_phone_e164 ~ ${E164}),
  ADD CONSTRAINT patients_whatsapp_opt_in_consistent CHECK (
    whatsapp_opt_in = (whatsapp_opted_in_at IS NOT NULL)
    AND whatsapp_opt_in = (whatsapp_opt_in_source IS NOT NULL)),
  ADD CONSTRAINT patients_whatsapp_opt_in_source_known CHECK (
    whatsapp_opt_in_source IS NULL OR whatsapp_opt_in_source IN ('in_person','paper_form','phone','message'));

GRANT UPDATE (whatsapp_phone_e164, whatsapp_opt_in, whatsapp_opted_in_at, whatsapp_opt_in_source)
  ON TABLE patients TO __APP_USER__;

-- ── the clinic's connection ────────────────────────────────────────────────
CREATE TABLE clinic_whatsapp_connections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  waba_id                 text NOT NULL,
  phone_number_id         text NOT NULL,
  display_phone_number    text,
  verified_name           text,
  encrypted_access_token  text NOT NULL,
  token_key_id            text NOT NULL,
  connection_status       text NOT NULL DEFAULT 'connected',
  last_tested_at          timestamptz,
  last_test_ok            boolean,
  last_test_result        text,
  last_success_at         timestamptz,
  connected_at            timestamptz NOT NULL DEFAULT now(),
  connected_by            uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cwc_waba_id_shape CHECK (waba_id ~ '^[0-9]{5,30}$'),
  CONSTRAINT cwc_phone_number_id_shape CHECK (phone_number_id ~ '^[0-9]{5,30}$'),
  CONSTRAINT cwc_status_known CHECK (connection_status IN ('connected','failed')),
  CONSTRAINT cwc_test_consistent CHECK ((last_tested_at IS NULL) = (last_test_ok IS NULL)),
  CONSTRAINT cwc_connected_by_fk FOREIGN KEY (connected_by, tenant_id) REFERENCES users (id, tenant_id)
);
${rls('clinic_whatsapp_connections')}
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE clinic_whatsapp_connections TO __APP_USER__;

-- ── templates ──────────────────────────────────────────────────────────────
CREATE TABLE whatsapp_message_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name        text NOT NULL,
  meta_template_name  text NOT NULL,
  language_code       text NOT NULL,
  preview_body        text NOT NULL,
  is_active           boolean NOT NULL DEFAULT true,
  is_default          boolean NOT NULL DEFAULT false,
  -- What Meta said the last time the template was checked.
  meta_status         text,
  meta_category       text,
  meta_parameters     jsonb,
  meta_checked_at     timestamptz,
  meta_check_error    text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wmt_display_name_present CHECK (btrim(display_name) <> '' AND char_length(display_name) <= 80),
  CONSTRAINT wmt_meta_name_shape CHECK (meta_template_name ~ '^[a-z0-9_]+$' AND char_length(meta_template_name) <= 512),
  CONSTRAINT wmt_language_shape CHECK (language_code ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  CONSTRAINT wmt_preview_present CHECK (btrim(preview_body) <> '' AND char_length(preview_body) <= 1024),
  CONSTRAINT wmt_default_is_active CHECK (NOT is_default OR is_active),
  CONSTRAINT wmt_parameters_array CHECK (meta_parameters IS NULL OR jsonb_typeof(meta_parameters) = 'array')
);
CREATE UNIQUE INDEX whatsapp_message_templates_id_tenant_key ON whatsapp_message_templates (id, tenant_id);
CREATE UNIQUE INDEX whatsapp_message_templates_meta_unique
  ON whatsapp_message_templates (tenant_id, meta_template_name, language_code);
CREATE UNIQUE INDEX whatsapp_message_templates_one_default
  ON whatsapp_message_templates (tenant_id) WHERE is_default;
${rls('whatsapp_message_templates')}
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE whatsapp_message_templates TO __APP_USER__;

-- ── batches: one confirmed click on Send ───────────────────────────────────
CREATE TABLE whatsapp_send_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  selected_date         date NOT NULL,
  template_id           uuid,
  template_name         text NOT NULL,
  selected_count        integer NOT NULL,
  sent_count            integer NOT NULL DEFAULT 0,
  failed_count          integer NOT NULL DEFAULT 0,
  skipped_count         integer NOT NULL DEFAULT 0,
  initiated_by_user_id  uuid,
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wsb_counts_sane CHECK (
    selected_count >= 0 AND sent_count >= 0 AND failed_count >= 0 AND skipped_count >= 0
    AND sent_count + failed_count + skipped_count <= selected_count),
  CONSTRAINT wsb_template_fk FOREIGN KEY (template_id, tenant_id)
    REFERENCES whatsapp_message_templates (id, tenant_id) ON DELETE SET NULL (template_id),
  CONSTRAINT wsb_user_fk FOREIGN KEY (initiated_by_user_id, tenant_id) REFERENCES users (id, tenant_id)
);
CREATE UNIQUE INDEX whatsapp_send_batches_id_tenant_key ON whatsapp_send_batches (id, tenant_id);
CREATE INDEX whatsapp_send_batches_recent ON whatsapp_send_batches (tenant_id, started_at DESC);
${rls('whatsapp_send_batches')}
GRANT SELECT, INSERT ON TABLE whatsapp_send_batches TO __APP_USER__;
GRANT UPDATE (sent_count, failed_count, skipped_count, completed_at) ON TABLE whatsapp_send_batches TO __APP_USER__;

-- ── one row per attempt ────────────────────────────────────────────────────
CREATE TABLE whatsapp_message_sends (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id         uuid NOT NULL,
  patient_id       uuid NOT NULL,
  appointment_id   uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  template_id      uuid,
  template_name    text NOT NULL,
  reminder_type    text NOT NULL DEFAULT 'appointment_reminder',
  recipient_phone  text,
  api_message_id   text,
  status           text NOT NULL DEFAULT 'queued',
  failure_reason   text,
  sent_by          uuid,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_status_known CHECK (
    status IN ('queued','sending','accepted','sent','failed','skipped','already_sent')),
  CONSTRAINT wms_type_known CHECK (reminder_type IN ('appointment_reminder')),
  CONSTRAINT wms_phone_e164 CHECK (recipient_phone IS NULL OR recipient_phone ~ ${E164}),
  CONSTRAINT wms_accepted_has_id CHECK (status NOT IN ('accepted','sent') OR api_message_id IS NOT NULL),
  CONSTRAINT wms_reason_when_not_sent CHECK (
    status NOT IN ('failed','skipped','already_sent') OR failure_reason IS NOT NULL),
  CONSTRAINT wms_batch_fk FOREIGN KEY (batch_id, tenant_id)
    REFERENCES whatsapp_send_batches (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT wms_patient_fk FOREIGN KEY (patient_id, tenant_id)
    REFERENCES patients (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT wms_template_fk FOREIGN KEY (template_id, tenant_id)
    REFERENCES whatsapp_message_templates (id, tenant_id) ON DELETE SET NULL (template_id),
  CONSTRAINT wms_sent_by_fk FOREIGN KEY (sent_by, tenant_id) REFERENCES users (id, tenant_id)
);
CREATE UNIQUE INDEX whatsapp_message_sends_one_live
  ON whatsapp_message_sends (tenant_id, appointment_id, patient_id, reminder_type)
  WHERE status IN ('queued','sending','accepted','sent');
CREATE INDEX whatsapp_message_sends_batch ON whatsapp_message_sends (batch_id);
CREATE INDEX whatsapp_message_sends_recent ON whatsapp_message_sends (tenant_id, created_at DESC);
CREATE INDEX whatsapp_message_sends_appointment ON whatsapp_message_sends (tenant_id, appointment_id);
CREATE UNIQUE INDEX whatsapp_message_sends_api_id ON whatsapp_message_sends (api_message_id)
  WHERE api_message_id IS NOT NULL;
${rls('whatsapp_message_sends')}
GRANT SELECT, INSERT ON TABLE whatsapp_message_sends TO __APP_USER__;
GRANT UPDATE (status, api_message_id, failure_reason, sent_at, updated_at)
  ON TABLE whatsapp_message_sends TO __APP_USER__;
`;

const DOWN = `
DROP TABLE IF EXISTS whatsapp_message_sends;
DROP TABLE IF EXISTS whatsapp_send_batches;
DROP TABLE IF EXISTS whatsapp_message_templates;
DROP TABLE IF EXISTS clinic_whatsapp_connections;
ALTER TABLE patients
  DROP CONSTRAINT IF EXISTS patients_whatsapp_opt_in_source_known,
  DROP CONSTRAINT IF EXISTS patients_whatsapp_opt_in_consistent,
  DROP CONSTRAINT IF EXISTS patients_whatsapp_phone_e164,
  DROP COLUMN IF EXISTS whatsapp_opt_in_source,
  DROP COLUMN IF EXISTS whatsapp_opted_in_at,
  DROP COLUMN IF EXISTS whatsapp_opt_in,
  DROP COLUMN IF EXISTS whatsapp_phone_e164;
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
