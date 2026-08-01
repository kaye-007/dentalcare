/**
 * 0003 — tenant isolation
 *
 * Makes shared-schema multitenancy enforced at the database:
 *   - a non-superuser runtime role (app_user) so RLS is not bypassed
 *   - Row-Level Security (ENABLE + FORCE) on tenant tables, scoped by the
 *     transaction-local GUC app.current_tenant_id
 *   - per-tenant email uniqueness (identity isolated per clinic)
 *   - a SECURITY DEFINER resolver so the subdomain->tenant lookup can run
 *     before any tenant context exists, without exposing other tenants
 *
 * Migrations + seed run as the privileged role (superuser) and therefore
 * bypass RLS by design. Only the runtime app_user is subject to it.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  const appUser = process.env.APP_DB_USER || 'app_user';
  const appPass = process.env.APP_DB_PASSWORD || 'app_user_dev_pw';

  // 1) Identity is unique per tenant, not globally.
  pgm.sql('DROP INDEX IF EXISTS users_email_lower_unique;');
  pgm.sql(
    'CREATE UNIQUE INDEX users_tenant_email_unique ON users (tenant_id, lower(email));',
  );

  // 2) Runtime application role (idempotent).
  pgm.sql(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${appUser}') THEN
        CREATE ROLE ${appUser} LOGIN PASSWORD '${appPass}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END $$;`);

  pgm.sql(`DO $$
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '${appUser}');
    END $$;`);
  pgm.sql(`GRANT USAGE ON SCHEMA public TO ${appUser};`);
  pgm.sql(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appUser};`,
  );
  pgm.sql(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appUser};`,
  );

  // 3) Row-Level Security. FORCE so it applies even to the table owner;
  //    superusers (migrations/seed) still bypass, which is intended.
  pgm.sql(`ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE tenants FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`CREATE POLICY tenant_isolation ON tenants
             USING (id = current_setting('app.current_tenant_id', true)::uuid);`);

  pgm.sql(`ALTER TABLE users ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE users FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`CREATE POLICY tenant_isolation ON users
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);

  // 4) Subdomain -> tenant resolver. Runs as definer (bypasses RLS) but only
  //    ever returns id + status for the one subdomain asked about.
  pgm.sql(`CREATE OR REPLACE FUNCTION resolve_tenant(p_subdomain text)
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
  pgm.sql(`REVOKE ALL ON FUNCTION resolve_tenant(text) FROM PUBLIC;`);
  pgm.sql(`GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO ${appUser};`);
};

exports.down = (pgm) => {
  const appUser = process.env.APP_DB_USER || 'app_user';

  pgm.sql('DROP FUNCTION IF EXISTS resolve_tenant(text);');
  pgm.sql('DROP POLICY IF EXISTS tenant_isolation ON users;');
  pgm.sql('DROP POLICY IF EXISTS tenant_isolation ON tenants;');
  pgm.sql('ALTER TABLE users NO FORCE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE users DISABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;');
  pgm.sql('DROP INDEX IF EXISTS users_tenant_email_unique;');
  pgm.sql('CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));');

  pgm.sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${appUser};`);
  pgm.sql(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${appUser};`);
  pgm.sql(`REVOKE USAGE ON SCHEMA public FROM ${appUser};`);
  // Role left in place on purpose (other DBs/objects may depend on it).
};
