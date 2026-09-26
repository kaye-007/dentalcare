/**
 * 0013 — foundations: the accountant, locations, idempotency, request
 * context in the audit trail, and feature entitlements
 *
 * Nothing here changes what an existing clinic sees. Each piece is something
 * a later module (the cash drawer first, 0014) needs to stand on.
 *
 * ── users.role: accountant ────────────────────────────────────────────────
 *
 * Reads invoices, payments, expenses, drawer reports, the aggregate finances
 * and payroll; writes nothing; never opens the clinical record. The grant
 * list lives in @dentalcare/shared/permissions.
 *
 * ── locations ─────────────────────────────────────────────────────────────
 *
 * A clinic with two addresses has two front desks, two sets of drawers and
 * two sets of numbers an owner wants apart. Every clinic gets one default
 * location now, named after the clinic, so everything that later carries a
 * location_id has one to point at. A location is deactivated, never deleted:
 * sessions and payments will name it for as long as they exist.
 *
 * `operatories.location_id` is filled with the default and stays nullable, so
 * an operatory created by code written before this migration still inserts.
 *
 * ── idempotency_keys ──────────────────────────────────────────────────────
 *
 * A receptionist's phone on a weak signal sends "take ALL 8,500 in cash",
 * hears nothing back, and sends it again. Without a key that is two payments,
 * two drawer entries and — once fiscalized — two fiscal invoices that can only
 * be undone by a corrective one. A request carrying `Idempotency-Key` records
 * the key before running and the response after, and a repeat gets the first
 * response back instead of a second payment.
 *
 * Bookkeeping, not evidence: the runtime role may update and delete these
 * rows, and they are worth nothing after a day.
 *
 * ── clinic_audit_log: request_id, ip, user_agent ──────────────────────────
 *
 * "Who voided the payment" was answered; "from which device, in which
 * request" was not. New columns only — the append-only trigger forbids
 * rewriting rows, and nothing here does. Existing rows keep NULL.
 *
 * ── entitlements ──────────────────────────────────────────────────────────
 *
 *   plan_entitlements              what a plan grants. Market data for every
 *                                  clinic on that plan: no tenant_id, no RLS,
 *                                  read-only for the runtime role.
 *   tenant_entitlement_overrides   a pilot or a custom deal for one clinic,
 *                                  written only from the platform plane, with
 *                                  a reason and usually an expiry
 *   tenant_feature_settings        the clinic's own switch
 *
 * Feature keys are checked for shape, not against a list: the catalogue is
 * code (@dentalcare/shared/features) and grows without a migration.
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

const FEATURE_KEY = `'^[a-z][a-z0-9_]{1,40}$'`;

const UP = `
-- ── the accountant ───────────────────────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'dentist', 'hygienist', 'assistant', 'receptionist', 'accountant'));

-- ── locations ────────────────────────────────────────────────────────────
CREATE TABLE locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  address     text,
  city        text,
  is_default  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT locations_name_present CHECK (btrim(name) <> ''),
  CONSTRAINT locations_default_is_active CHECK (NOT is_default OR is_active)
);

CREATE UNIQUE INDEX locations_id_tenant_key ON locations (id, tenant_id);
CREATE UNIQUE INDEX locations_one_default ON locations (tenant_id) WHERE is_default;

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON locations
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Deactivated, never deleted.
GRANT SELECT, INSERT ON TABLE locations TO __APP_USER__;
GRANT UPDATE (name, address, city, is_default, is_active, updated_at) ON TABLE locations TO __APP_USER__;

-- One default location per existing clinic. FORCE binds the owner too; lift
-- it on the tables this statement reads and writes across every clinic.
ALTER TABLE locations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clinic_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
INSERT INTO locations (tenant_id, name, address, city, is_default)
SELECT t.id, t.name, cs.address, cs.city, true
  FROM tenants t
  LEFT JOIN clinic_settings cs ON cs.tenant_id = t.id;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE clinic_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;

ALTER TABLE operatories
  ADD COLUMN location_id uuid;

ALTER TABLE operatories NO FORCE ROW LEVEL SECURITY;
ALTER TABLE locations NO FORCE ROW LEVEL SECURITY;
UPDATE operatories o SET location_id = l.id
  FROM locations l WHERE l.tenant_id = o.tenant_id AND l.is_default;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
ALTER TABLE operatories FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operatories_id_tenant_key') THEN
    ALTER TABLE operatories ADD CONSTRAINT operatories_id_tenant_key UNIQUE (id, tenant_id);
  END IF;
END $$;

ALTER TABLE operatories
  ADD CONSTRAINT operatories_location_fk FOREIGN KEY (location_id, tenant_id)
    REFERENCES locations (id, tenant_id);

-- ── idempotency keys ─────────────────────────────────────────────────────
CREATE TABLE idempotency_keys (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key              text NOT NULL,
  user_id          uuid,
  request_method   text NOT NULL,
  request_path     text NOT NULL,
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'in_progress',
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  PRIMARY KEY (tenant_id, key),
  CONSTRAINT idempotency_key_shape CHECK (key ~ '^[A-Za-z0-9_-]{16,128}$'),
  CONSTRAINT idempotency_status_known CHECK (status IN ('in_progress', 'completed')),
  CONSTRAINT idempotency_completed_consistent CHECK (
    (status = 'completed') = (completed_at IS NOT NULL AND response_status IS NOT NULL))
);

CREATE INDEX idempotency_keys_age_idx ON idempotency_keys (created_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE idempotency_keys TO __APP_USER__;

-- ── request context on the audit trail ───────────────────────────────────
ALTER TABLE clinic_audit_log
  ADD COLUMN request_id text,
  ADD COLUMN ip text,
  ADD COLUMN user_agent text,
  ADD CONSTRAINT clinic_audit_context_sane CHECK (
    (request_id IS NULL OR char_length(request_id) <= 128)
    AND (ip IS NULL OR char_length(ip) <= 64)
    AND (user_agent IS NULL OR char_length(user_agent) <= 512));

-- ── entitlements ─────────────────────────────────────────────────────────
CREATE TABLE plan_entitlements (
  plan_id      uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_key  text NOT NULL,
  value        jsonb NOT NULL,
  PRIMARY KEY (plan_id, feature_key),
  CONSTRAINT plan_entitlements_key_shape CHECK (feature_key ~ ${FEATURE_KEY})
);

GRANT SELECT ON TABLE plan_entitlements TO __APP_USER__;

CREATE TABLE tenant_entitlement_overrides (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_key  text NOT NULL,
  value        jsonb NOT NULL,
  reason       text NOT NULL,
  expires_at   timestamptz,
  created_by   uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  CONSTRAINT teo_key_shape CHECK (feature_key ~ ${FEATURE_KEY}),
  CONSTRAINT teo_reason_present CHECK (btrim(reason) <> ''),
  CONSTRAINT teo_revoked_consistent CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- At most one live override per feature per clinic.
CREATE UNIQUE INDEX teo_one_active ON tenant_entitlement_overrides (tenant_id, feature_key)
  WHERE revoked_at IS NULL;

ALTER TABLE tenant_entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_entitlement_overrides FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_entitlement_overrides
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- A clinic reads its overrides; only the platform plane writes them.
GRANT SELECT ON TABLE tenant_entitlement_overrides TO __APP_USER__;

CREATE TABLE tenant_feature_settings (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_key  text NOT NULL,
  enabled      boolean NOT NULL,
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key),
  CONSTRAINT tfs_key_shape CHECK (feature_key ~ ${FEATURE_KEY}),
  CONSTRAINT tfs_config_object CHECK (jsonb_typeof(config) = 'object')
);

ALTER TABLE tenant_feature_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_feature_settings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT ON TABLE tenant_feature_settings TO __APP_USER__;
GRANT UPDATE (enabled, config, updated_by, updated_at) ON TABLE tenant_feature_settings TO __APP_USER__;
`;

const DOWN = `
DROP TABLE IF EXISTS tenant_feature_settings;
DROP TABLE IF EXISTS tenant_entitlement_overrides;
DROP TABLE IF EXISTS plan_entitlements;

ALTER TABLE clinic_audit_log
  DROP CONSTRAINT IF EXISTS clinic_audit_context_sane,
  DROP COLUMN IF EXISTS user_agent,
  DROP COLUMN IF EXISTS ip,
  DROP COLUMN IF EXISTS request_id;

DROP TABLE IF EXISTS idempotency_keys;

ALTER TABLE operatories
  DROP CONSTRAINT IF EXISTS operatories_location_fk,
  DROP COLUMN IF EXISTS location_id;

DROP TABLE IF EXISTS locations;

-- An accountant cannot be silently turned into anything else: refuse, and
-- let a person decide what each of them becomes.
DO $$
BEGIN
  ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM users WHERE role = 'accountant') THEN
    ALTER TABLE users FORCE ROW LEVEL SECURITY;
    RAISE EXCEPTION 'Accountant accounts exist; change their role before rolling back 0013';
  END IF;
  ALTER TABLE users FORCE ROW LEVEL SECURITY;
END $$;

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'dentist', 'hygienist', 'assistant', 'receptionist'));
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
