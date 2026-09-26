import { Client, Pool, PoolClient, QueryResultRow } from 'pg';

/**
 * Connections for the integration suite, named after the thing that matters
 * about each: which role it is.
 *
 * `owner` is the migration role. It created every table, so RLS does not
 * apply to it beyond FORCE, and it can see across tenants. Fixtures use it,
 * because setting up two clinics is by definition a cross-tenant act.
 *
 * `app` is app_user — NOSUPERUSER, NOBYPASSRLS, created by migration 0003.
 * It is what the API connects as at runtime, and every assertion about
 * isolation has to be made through it. An isolation test run as the owner
 * passes for the wrong reason and would keep passing after the policies were
 * dropped.
 */

const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;

if (!OWNER_URL || !APP_URL) {
  throw new Error(
    'The integration suite needs DATABASE_URL and APP_DATABASE_URL.\n' +
      '  Both are read from the repository .env automatically\n' +
      '  (jest.integration.config.js -> test/integration/env.setup.js),\n' +
      '  so reaching this means .env is missing or does not set them.\n' +
      '  Locally:  cp .env.example .env && npm run dev:up\n' +
      '  APP_DATABASE_URL must point at app_user, not at the owner role, or\n' +
      '  the isolation tests prove nothing.',
  );
}

let ownerPool: Pool | undefined;
let appPool: Pool | undefined;

export function owner(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 4 });
  return ownerPool;
}

export function app(): Pool {
  appPool ??= new Pool({ connectionString: APP_URL, max: 4 });
  return appPool;
}

export async function closePools(): Promise<void> {
  await Promise.allSettled([ownerPool?.end(), appPool?.end()]);
  ownerPool = undefined;
  appPool = undefined;
}

/**
 * Run `fn` as app_user inside a transaction with the tenant context set,
 * exactly as DatabaseService.withTenant does at runtime.
 *
 * Transaction-local (`set_config(..., true)`), so the setting cannot leak into
 * the next test through a pooled connection — which would silently turn a
 * cross-tenant test into a same-tenant one.
 */
export async function asTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_tenant_id',
      tenantId,
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Convenience for one-off owner queries. */
export async function ownerQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
) {
  return owner().query<T>(text, params);
}

/**
 * The PostgreSQL error code from a rejected query, or null if it resolved.
 *
 * Tests assert on the code rather than the message: '42501' is
 * insufficient_privilege regardless of locale or server version, while the
 * message is prose that a minor upgrade may reword.
 */
export async function errorCodeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
}

/** A fresh single-use connection, for tests that need to control the session. */
export async function rawClient(url: 'owner' | 'app'): Promise<Client> {
  const client = new Client({
    connectionString: url === 'owner' ? OWNER_URL : APP_URL,
  });
  await client.connect();
  return client;
}
