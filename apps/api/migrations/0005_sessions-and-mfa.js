/**
 * 0005 — sessions and multi-factor authentication
 *
 * ── Sessions ──────────────────────────────────────────────────────────────
 *
 * Refresh tokens were JWTs: seven days, self-contained, unrevocable. Logout
 * was the browser forgetting the token, and a stolen one outlived a password
 * change. `user_sessions` (clinic, under RLS) and `platform_sessions`
 * (console) make them rows: rotated on every use, revocable per sign-in, and
 * revoked wholesale when a password changes, an account is disabled or a
 * token is replayed. See apps/api/src/core/sessions/session-store.ts.
 *
 * Only a SHA-256 of each token's secret is stored.
 *
 * ── MFA ───────────────────────────────────────────────────────────────────
 *
 * The baseline carried `totp_secret text` on users and platform_admins, with
 * no code behind it anywhere in this repository. Plain text, in a table the
 * tenant role can read. Those columns are dropped here — refusing to run if
 * any of them hold a value, because silently discarding someone's second
 * factor would lock them out.
 *
 * Factors move to their own tables:
 *
 *   one row per factor, not one column per kind, so a passkey later is a new
 *   `kind`, not a schema change to users;
 *
 *   the secret is AES-256-GCM ciphertext with the id of the key that sealed
 *   it — the key lives in MFA_ENCRYPTION_KEYS, never in the database;
 *
 *   `last_used_step` stops a TOTP code being replayed, and
 *   `failed_attempts` / `locked_until` stop one being guessed.
 *
 * Recovery codes are keyed hashes, one row each, spent by setting `used_at`.
 *
 * The runtime role gets column-level UPDATE on factors: it can confirm,
 * count failures, lock and disable, and it cannot rewrite a secret in place.
 *
 * ── Policy ────────────────────────────────────────────────────────────────
 *
 * Administrators and every console account must use MFA; that floor is in
 * code, not here. `clinic_settings.mfa_required_for_all` lets a clinic extend
 * it to everyone.
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

const sessionTable = (name, ownerColumn, ownerTable, tenant) => `
CREATE TABLE ${name} (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ${tenant ? 'tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,' : ''}
  ${ownerColumn}  uuid NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE,
  family_id       uuid NOT NULL,
  token_hash      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_used_at    timestamptz,
  rotated_at      timestamptz,
  revoked_at      timestamptz,
  revoked_reason  text,
  mfa_verified_at timestamptz,
  user_agent      text,
  ip              text,
  CONSTRAINT ${name}_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ${name}_revocation_consistent
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX ${name}_owner_active_idx ON ${name} (${ownerColumn}) WHERE revoked_at IS NULL;
CREATE INDEX ${name}_family_idx ON ${name} (family_id);
`;

const factorTable = (name, ownerColumn, ownerTable, tenant) => `
CREATE TABLE ${name} (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ${tenant ? 'tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,' : ''}
  ${ownerColumn}    uuid NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE,
  kind              text NOT NULL DEFAULT 'totp',
  label             text,
  secret_ciphertext text NOT NULL,
  key_id            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz,
  last_used_step    bigint,
  failed_attempts   integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  disabled_at       timestamptz,
  CONSTRAINT ${name}_kind_known CHECK (kind IN ('totp')),
  CONSTRAINT ${name}_attempts_sane CHECK (failed_attempts >= 0)
);
-- One live factor of each kind per account. An abandoned, unconfirmed setup
-- is disabled before a new one starts rather than deleted.
CREATE UNIQUE INDEX ${name}_one_live_idx ON ${name} (${ownerColumn}, kind)
  WHERE disabled_at IS NULL;

CREATE TABLE ${name.replace('_factors', '_recovery_codes')} (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ${tenant ? 'tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,' : ''}
  ${ownerColumn} uuid NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  key_id      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX ${name.replace('_factors', '_recovery_codes')}_owner_idx
  ON ${name.replace('_factors', '_recovery_codes')} (${ownerColumn})
  WHERE used_at IS NULL AND revoked_at IS NULL;
`;

const rls = (table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${table}
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
`;

const UP = `
${sessionTable('user_sessions', 'user_id', 'users', true)}
${rls('user_sessions')}
${sessionTable('platform_sessions', 'admin_id', 'platform_admins', false)}

${factorTable('user_mfa_factors', 'user_id', 'users', true)}
${rls('user_mfa_factors')}
${rls('user_mfa_recovery_codes')}
${factorTable('platform_mfa_factors', 'admin_id', 'platform_admins', false)}

ALTER TABLE clinic_settings
  ADD COLUMN mfa_required_for_all boolean NOT NULL DEFAULT false;

-- ── retire the plaintext columns ────────────────────────────────────────
-- users is FORCE RLS, which binds the owner too: with no tenant in context a
-- plain SELECT sees no rows and the check below would pass on a database full
-- of secrets. NO FORCE for the length of this transaction lets the owner see
-- every row; FORCE is restored before commit.
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE totp_secret IS NOT NULL OR totp_enabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'users.totp_secret holds data. Migrate those factors into user_mfa_factors before running 0005; dropping them would lock those users out.';
  END IF;
  IF EXISTS (SELECT 1 FROM platform_admins WHERE totp_secret IS NOT NULL OR totp_enabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'platform_admins.totp_secret holds data. Migrate those factors into platform_mfa_factors before running 0005.';
  END IF;
END $$;
ALTER TABLE users
  DROP CONSTRAINT users_totp_consistent,
  DROP COLUMN totp_secret,
  DROP COLUMN totp_enabled_at;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

ALTER TABLE platform_admins
  DROP CONSTRAINT platform_admins_totp_consistent,
  DROP COLUMN totp_secret,
  DROP COLUMN totp_enabled_at;

-- ── grants ──────────────────────────────────────────────────────────────
-- Sessions: DELETE so a sign-in can clear that user's long-expired rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON user_sessions TO __APP_USER__;

-- Factors: never rewritten in place. Confirm, count, lock, disable.
GRANT SELECT, INSERT ON user_mfa_factors TO __APP_USER__;
GRANT UPDATE (confirmed_at, last_used_step, failed_attempts, locked_until, disabled_at)
  ON user_mfa_factors TO __APP_USER__;

GRANT SELECT, INSERT ON user_mfa_recovery_codes TO __APP_USER__;
GRANT UPDATE (used_at, revoked_at) ON user_mfa_recovery_codes TO __APP_USER__;

-- platform_sessions, platform_mfa_factors and platform_mfa_recovery_codes
-- carry no grant at all: the tenant role has no business with the console.
`;

const DOWN = `
DROP TABLE IF EXISTS platform_mfa_recovery_codes;
DROP TABLE IF EXISTS platform_mfa_factors;
DROP TABLE IF EXISTS user_mfa_recovery_codes;
DROP TABLE IF EXISTS user_mfa_factors;
DROP TABLE IF EXISTS platform_sessions;
DROP TABLE IF EXISTS user_sessions;

ALTER TABLE clinic_settings DROP COLUMN mfa_required_for_all;

ALTER TABLE users
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD CONSTRAINT users_totp_consistent
    CHECK ((totp_enabled_at IS NULL) OR (totp_secret IS NOT NULL));
ALTER TABLE platform_admins
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD CONSTRAINT platform_admins_totp_consistent
    CHECK ((totp_enabled_at IS NULL) OR (totp_secret IS NOT NULL));
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

/**
 * Reversible, and lossy by design: every session and every enrolled factor is
 * dropped. After rolling back, everyone signs in again and nobody has MFA.
 */
exports.down = (pgm) => {
  pgm.sql(DOWN);
};
