/**
 * 0019 — make the trial real, and leave room for the login code
 *
 * ── The trial ─────────────────────────────────────────────────────────────
 *
 * `tenants.trial_ends_at` has existed since 0004. It is set when a clinic is
 * created, shown in the admin panel, and read by nothing: a 7-day demo has
 * been running forever. Enforcing it needs the date at the moment a request
 * resolves its clinic, which is `resolve_tenant` — so the function grows a
 * third column.
 *
 * The date is the whole state. There is no `is_trial` flag to drift out of
 * step with it:
 *
 *     trial_ends_at IS NULL          -> a paying clinic, no restriction
 *     trial_ends_at >= now()         -> a trial still running
 *     trial_ends_at <  now()         -> expired: reads yes, writes no
 *
 * Converting a demo to paid is `SET trial_ends_at = NULL`. Extending it is a
 * new date. Both are one column, so the two can never disagree.
 *
 * ── The login code ────────────────────────────────────────────────────────
 *
 * Columns only, deliberately inert. Kaye plans Google Authenticator later;
 * adding the two columns now means that becomes a feature to build rather
 * than a migration against a live database with real clinics on it. Nothing
 * reads them yet, and login is unchanged.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  const appUser = process.env.APP_DB_USER || 'app_user';

  /* ── 1. resolve_tenant learns about trials ─────────────────────────────
     The return type changes, so this is a DROP and CREATE rather than a
     CREATE OR REPLACE, and the grant has to be reapplied afterwards.
     SECURITY DEFINER is preserved: app_user cannot read `tenants` directly
     across clinics, and this function is the one narrow window it has. */
  pgm.sql('DROP FUNCTION IF EXISTS resolve_tenant(text);');
  pgm.sql(`CREATE FUNCTION resolve_tenant(p_subdomain text)
             RETURNS TABLE (id uuid, status text, trial_ends_at timestamptz)
             LANGUAGE sql
             SECURITY DEFINER
             SET search_path = public
             AS $$
               SELECT t.id, t.status, t.trial_ends_at
                 FROM tenants t
                WHERE t.subdomain = lower(p_subdomain)
                LIMIT 1;
             $$;`);
  pgm.sql('REVOKE ALL ON FUNCTION resolve_tenant(text) FROM PUBLIC;');
  pgm.sql(`GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO ${appUser};`);

  // Finding an expiring trial should not mean scanning every clinic.
  pgm.createIndex('tenants', 'trial_ends_at', {
    name: 'tenants_trial_ends_at_idx',
    where: 'trial_ends_at IS NOT NULL',
  });

  /* ── 2. somewhere to put the authenticator secret, later ─────────────── */
  for (const table of ['users', 'platform_admins']) {
    pgm.addColumns(table, {
      /**
       * Base32 TOTP secret. Nothing writes this yet. When it does, it is a
       * shared secret — it must be encrypted at rest before a single row is
       * populated, not after.
       */
      totp_secret: { type: 'text' },
      /** Null until the first correct code proves the pairing worked. */
      totp_enabled_at: { type: 'timestamptz' },
    });
    pgm.sql(`
      ALTER TABLE ${table} ADD CONSTRAINT ${table}_totp_consistent
        CHECK (totp_enabled_at IS NULL OR totp_secret IS NOT NULL);
    `);
  }
};

exports.down = (pgm) => {
  const appUser = process.env.APP_DB_USER || 'app_user';

  for (const table of ['users', 'platform_admins']) {
    pgm.sql(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_totp_consistent;`);
    pgm.dropColumns(table, ['totp_secret', 'totp_enabled_at']);
  }

  pgm.dropIndex('tenants', 'trial_ends_at', {
    name: 'tenants_trial_ends_at_idx',
    ifExists: true,
  });

  pgm.sql('DROP FUNCTION IF EXISTS resolve_tenant(text);');
  pgm.sql(`CREATE FUNCTION resolve_tenant(p_subdomain text)
             RETURNS TABLE (id uuid, status text)
             LANGUAGE sql
             SECURITY DEFINER
             SET search_path = public
             AS $$
               SELECT t.id, t.status
                 FROM tenants t
                WHERE t.subdomain = lower(p_subdomain)
                LIMIT 1;
             $$;`);
  pgm.sql('REVOKE ALL ON FUNCTION resolve_tenant(text) FROM PUBLIC;');
  pgm.sql(`GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO ${appUser};`);
};
