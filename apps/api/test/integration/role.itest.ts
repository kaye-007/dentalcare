import { app, closePools, ownerQuery } from './db';

/**
 * The assumptions every other integration test rests on.
 *
 * If app_user could bypass RLS, the isolation suite would pass while proving
 * nothing — every query would return everything and every "the other clinic's
 * row is invisible" assertion would be measuring an application filter that
 * deliberately does not exist. So this runs first and states the premise out
 * loud: the connection under test is the restricted role, and the tables it
 * touches actually carry policies.
 */
afterAll(closePools);

describe('the runtime role', () => {
  it('is not the owner role', async () => {
    const { rows } = await app().query<{ current_user: string }>('SELECT current_user');
    const owner = await ownerQuery<{ current_user: string }>('SELECT current_user');

    expect(rows[0].current_user).not.toBe(owner.rows[0].current_user);
  });

  /**
   * SUPERUSER and BYPASSRLS each defeat every policy in the schema, silently
   * and completely. DatabaseService checks this at boot for the same reason;
   * this checks that the check has something true to find.
   */
  it('can neither be a superuser nor bypass row-level security', async () => {
    const { rows } = await app().query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');

    expect(rows).toHaveLength(1);
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
  });
});

describe('row-level security coverage', () => {
  /**
   * ENABLE alone is not enough. Without FORCE, the table owner is exempt —
   * and on a deployment where the API and the migrations share a role, that
   * exemption is the whole isolation model gone.
   */
  it('every tenant_id table has RLS enabled AND forced', async () => {
    const { rows } = await ownerQuery<{
      tablename: string;
      rowsecurity: boolean;
      forced: boolean;
    }>(`
      SELECT c.relname   AS tablename,
             c.relrowsecurity  AS rowsecurity,
             c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND EXISTS (
               SELECT 1 FROM information_schema.columns col
                WHERE col.table_schema = 'public'
                  AND col.table_name = c.relname
                  AND col.column_name = 'tenant_id')
       ORDER BY c.relname
    `);

    expect(rows.length).toBeGreaterThan(0);

    const unprotected = rows.filter((r) => !r.rowsecurity || !r.forced);
    expect(unprotected.map((r) => r.tablename)).toEqual([]);
  });

  it('the tenants table itself has RLS enabled and forced', async () => {
    const { rows } = await ownerQuery<{
      rowsecurity: boolean;
      forced: boolean;
    }>(`
      SELECT c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'tenants'
    `);

    expect(rows[0].rowsecurity).toBe(true);
    expect(rows[0].forced).toBe(true);
  });

  it('every RLS-enabled table carries a tenant_isolation policy', async () => {
    const { rows } = await ownerQuery<{ tablename: string; policies: number }>(`
      SELECT c.relname AS tablename,
             count(p.polname) FILTER (WHERE p.polname = 'tenant_isolation') AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policy p ON p.polrelid = c.oid
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relrowsecurity
       GROUP BY c.relname
       ORDER BY c.relname
    `);

    expect(rows.length).toBeGreaterThan(0);

    const missing = rows.filter((r) => Number(r.policies) === 0);
    expect(missing.map((r) => r.tablename)).toEqual([]);
  });
});
