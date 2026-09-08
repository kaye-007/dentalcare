/**
 * 0021 — a clinic cannot rewrite its own commercial state
 *
 * 0003 granted the runtime role DML on every table in `public`, and set
 * default privileges so every table created afterwards inherited the same.
 * That was right for the clinical tables and wrong for three others, which
 * only became visible once the platform plane existed:
 *
 *     tenants      DELETE, INSERT, SELECT, UPDATE
 *     plans        DELETE, INSERT, SELECT, UPDATE
 *     pgmigrations DELETE, INSERT, SELECT, UPDATE
 *
 * RLS is doing its job on `tenants` — the policy pins the role to its own
 * row — but "its own row" is exactly the row that says whether the clinic is
 * suspended, which plan it is on, and when its trial ends. A clinic
 * connection could lift its own suspension, move itself to a better plan, or
 * push `trial_ends_at` out a decade. `plans` is the price list itself, and
 * `pgmigrations` is the record of what has been applied.
 *
 * None of that is reachable through the API today. That is not the point: the
 * API is one SQL string away from making it reachable, and a privilege the
 * role does not hold cannot be handed out by a mistake in a service.
 *
 * ── Why UPDATE comes back for two columns ─────────────────────────────────
 *
 * `tenants.name` is the clinic's own display name, edited from Settings by
 * the doctor — SettingsService.update writes it on the tenant plane. It is
 * not commercial state; it shares a table with commercial state. So this
 * follows the shape 0018 established for payments: revoke the privilege
 * wholesale, then grant back precisely the columns the application is meant
 * to write. Everything unnamed here — status, plan_id, trial_ends_at,
 * subdomain, created_at — is now unwritable by the runtime role, for this
 * code and for any code written after it.
 *
 * INSERT on `tenants` is left alone deliberately. The policy has no
 * WITH CHECK, so PostgreSQL reuses USING for new rows: an insert would have
 * to carry `id = app.current_tenant_id`, which is a primary-key collision
 * with the row that setting names. It is already impossible, and revoking it
 * would only add a line that reads as if it were load-bearing.
 *
 * Creating clinics, changing their status and moving them between plans all
 * remain available on the privileged platform connection, which is where
 * TenantsService already does them.
 */

exports.shorthands = undefined;

/** Columns of `tenants` the clinic itself owns. */
const TENANT_SELF_COLUMNS = 'name, updated_at';

exports.up = (pgm) => {
  const appUser = process.env.APP_DB_USER || 'app_user';

  /* ── 1. commercial state on the clinic's own row ─────────────────────── */
  pgm.sql(`REVOKE UPDATE, DELETE ON tenants FROM ${appUser};`);
  pgm.sql(`GRANT UPDATE (${TENANT_SELF_COLUMNS}) ON tenants TO ${appUser};`);

  /* ── 2. the price list ───────────────────────────────────────────────── */
  /* SELECT stays: a clinic may need to read the plan it is on. Writing the
     catalogue is a platform action and belongs to the privileged role. */
  pgm.sql(`REVOKE INSERT, UPDATE, DELETE ON plans FROM ${appUser};`);

  /* ── 3. the migration ledger ─────────────────────────────────────────── */
  /* node-pg-migrate creates this before the first migration runs, so 0003's
     GRANT ... ON ALL TABLES caught it. The runtime role has no business
     reading which migrations have been applied, let alone editing the list
     so a re-run skips one. */
  pgm.sql(`REVOKE ALL ON pgmigrations FROM ${appUser};`);
};

exports.down = (pgm) => {
  const appUser = process.env.APP_DB_USER || 'app_user';

  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON pgmigrations TO ${appUser};`);
  pgm.sql(`GRANT INSERT, UPDATE, DELETE ON plans TO ${appUser};`);
  // Drop the narrow grant before restoring the wide one, so the table does
  // not end up carrying both a table-level and a column-level UPDATE.
  pgm.sql(`REVOKE UPDATE (${TENANT_SELF_COLUMNS}) ON tenants FROM ${appUser};`);
  pgm.sql(`GRANT UPDATE, DELETE ON tenants TO ${appUser};`);
};
