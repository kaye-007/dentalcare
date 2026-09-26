/**
 * 0008 — reminders that reach the patient
 *
 * Until now every reminder was delivered to an internal log and nowhere else.
 * This is what real delivery needs from the schema.
 *
 * ── reminders ─────────────────────────────────────────────────────────────
 *
 *   status        pending    claimed; waiting for its first attempt or a retry
 *                 sending    an attempt is in flight. A row left here means the
 *                            process died between the provider call and the
 *                            record of it; it is NOT retried automatically,
 *                            because the message may already have gone out and
 *                            a duplicate is worse than a gap someone can see.
 *                 sent       the provider accepted it (or, for WhatsApp and
 *                            email, a person handed it off)
 *                 delivered  the carrier confirmed delivery
 *                 failed     refused, or out of attempts
 *                 skipped    deliberately not sent — opted out, no usable
 *                            number, or the appointment stopped being upcoming
 *
 *   attempts, next_attempt_at        retries for a provider that said "busy"
 *   to_address                       the E.164 number actually used
 *   provider_message_id, _status     the provider's reference, which is what a
 *                                    delivery receipt names
 *   error_code, delivered_at
 *
 * No DELETE for the runtime role any more: a reminder row is the record that
 * the clinic contacted a patient, and the answer to "did we tell them?".
 *
 * ── patients ──────────────────────────────────────────────────────────────
 *
 * reminders_opt_out, with when and how: 'staff' (ticked on the patient's
 * record), 'patient' (replied STOP — reported by a delivery receipt) or
 * 'provider' (the provider refused to send to an unsubscribed number).
 *
 * ── clinic_settings ───────────────────────────────────────────────────────
 *
 * timezone            reminders said "10:30" in the server's zone, which is
 *                     UTC on Cloudflare. Defaulted to Europe/Tirane for the
 *                     clinics that exist today — the product's +355 and ALL
 *                     defaults already assume Albania.
 * reminder_locale     'en' or 'sq'
 * reminder_template   a clinic's own wording, or NULL for the built-in one
 * phone_country_code  for numbers written the local way ("069 …")
 * reminders_last_scan_at
 *                     the scheduler visits the clinic scanned longest ago
 *                     first, so a slow clinic cannot starve the rest
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

const UP = `
-- ── clinic settings ─────────────────────────────────────────────────────
ALTER TABLE clinic_settings
  ADD COLUMN timezone text NOT NULL DEFAULT 'Europe/Tirane',
  ADD COLUMN reminder_locale text NOT NULL DEFAULT 'en',
  ADD COLUMN reminder_template text,
  ADD COLUMN phone_country_code text NOT NULL DEFAULT '355',
  ADD COLUMN reminders_last_scan_at timestamptz,
  ADD CONSTRAINT cs_timezone_present CHECK (btrim(timezone) <> ''),
  ADD CONSTRAINT cs_reminder_locale_known CHECK (reminder_locale IN ('en','sq')),
  ADD CONSTRAINT cs_reminder_template_length CHECK (
    reminder_template IS NULL OR char_length(btrim(reminder_template)) BETWEEN 20 AND 480),
  ADD CONSTRAINT cs_phone_country_code_valid CHECK (phone_country_code ~ '^[1-9][0-9]{0,2}$');

-- ── patient consent ─────────────────────────────────────────────────────
ALTER TABLE patients
  ADD COLUMN reminders_opt_out boolean NOT NULL DEFAULT false,
  ADD COLUMN reminders_opt_out_at timestamptz,
  ADD COLUMN reminders_opt_out_source text,
  ADD CONSTRAINT patients_reminder_opt_out_consistent CHECK (
    reminders_opt_out = (reminders_opt_out_at IS NOT NULL)
    AND reminders_opt_out = (reminders_opt_out_source IS NOT NULL)),
  ADD CONSTRAINT patients_reminder_opt_out_source_known CHECK (
    reminders_opt_out_source IS NULL OR reminders_opt_out_source IN ('staff','patient','provider'));

-- ── reminders ───────────────────────────────────────────────────────────
ALTER TABLE reminders DROP CONSTRAINT reminders_status_check;

ALTER TABLE reminders
  ADD COLUMN to_address text,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN provider_message_id text,
  ADD COLUMN provider_status text,
  ADD COLUMN error_code text,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT reminders_status_check CHECK (
    status IN ('pending','sending','sent','delivered','failed','skipped')),
  ADD CONSTRAINT reminders_attempts_sane CHECK (attempts BETWEEN 0 AND 10),
  ADD CONSTRAINT reminders_delivered_consistent CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  ADD CONSTRAINT reminders_to_address_e164 CHECK (
    to_address IS NULL OR to_address ~ '^\\+[1-9][0-9]{7,14}$');

-- A delivery receipt names the provider's message id. One message, one row.
CREATE UNIQUE INDEX reminders_provider_message_unique
  ON reminders (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- What the scheduler asks every pass: which reminders are waiting to be tried.
CREATE INDEX reminders_due_idx
  ON reminders (tenant_id, next_attempt_at) WHERE status = 'pending';

REVOKE DELETE ON TABLE reminders FROM __APP_USER__;
`;

const DOWN = `
GRANT DELETE ON TABLE reminders TO __APP_USER__;

DROP INDEX IF EXISTS reminders_due_idx;
DROP INDEX IF EXISTS reminders_provider_message_unique;

ALTER TABLE reminders
  DROP CONSTRAINT IF EXISTS reminders_to_address_e164,
  DROP CONSTRAINT IF EXISTS reminders_delivered_consistent,
  DROP CONSTRAINT IF EXISTS reminders_attempts_sane,
  DROP CONSTRAINT IF EXISTS reminders_status_check;

-- FORCE binds the owner too; lift it for the one statement that has to see
-- every clinic's rows.
ALTER TABLE reminders NO FORCE ROW LEVEL SECURITY;
UPDATE reminders
   SET status = CASE status
                  WHEN 'delivered' THEN 'sent'
                  WHEN 'sending'   THEN 'pending'
                  WHEN 'skipped'   THEN 'failed'
                  ELSE status
                END
 WHERE status IN ('delivered','sending','skipped');
ALTER TABLE reminders FORCE ROW LEVEL SECURITY;

ALTER TABLE reminders
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS delivered_at,
  DROP COLUMN IF EXISTS error_code,
  DROP COLUMN IF EXISTS provider_status,
  DROP COLUMN IF EXISTS provider_message_id,
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS attempts,
  DROP COLUMN IF EXISTS to_address,
  ADD CONSTRAINT reminders_status_check CHECK (status IN ('pending','sent','failed'));

ALTER TABLE patients
  DROP CONSTRAINT IF EXISTS patients_reminder_opt_out_source_known,
  DROP CONSTRAINT IF EXISTS patients_reminder_opt_out_consistent,
  DROP COLUMN IF EXISTS reminders_opt_out_source,
  DROP COLUMN IF EXISTS reminders_opt_out_at,
  DROP COLUMN IF EXISTS reminders_opt_out;

ALTER TABLE clinic_settings
  DROP CONSTRAINT IF EXISTS cs_phone_country_code_valid,
  DROP CONSTRAINT IF EXISTS cs_reminder_template_length,
  DROP CONSTRAINT IF EXISTS cs_reminder_locale_known,
  DROP CONSTRAINT IF EXISTS cs_timezone_present,
  DROP COLUMN IF EXISTS reminders_last_scan_at,
  DROP COLUMN IF EXISTS phone_country_code,
  DROP COLUMN IF EXISTS reminder_template,
  DROP COLUMN IF EXISTS reminder_locale,
  DROP COLUMN IF EXISTS timezone;
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

exports.down = (pgm) => {
  pgm.sql(DOWN.replace(/__APP_USER__/g, appUser()));
};
