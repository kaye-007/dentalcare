import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResultRow } from 'pg';

/**
 * Data-access layer over two planes:
 *
 *  - app plane   (APP_DATABASE_URL, non-superuser) — the tenant plane. RLS is
 *    enforced; use withTenant() so app.current_tenant_id is set.
 *  - admin plane (DATABASE_URL, privileged) — the platform plane. Operates
 *    across all tenants (list/create/suspend) and therefore must bypass RLS.
 *    Reachable only by superadmin-guarded code.
 *
 * ── Two runtimes ─────────────────────────────────────────────────────────
 *
 * On Node (the container image, local development) each plane keeps a
 * resident pg.Pool for the process lifetime, which is what a long-running
 * server should do.
 *
 * On Cloudflare Workers it cannot. A Worker may not use a socket that was
 * opened while a different request was in flight, so a pool that outlives one
 * request is not merely wasteful — the second request to touch it fails. The
 * connection strings on that runtime come from Hyperdrive, which IS the pool;
 * a per-operation pool of one connection in front of it is the intended
 * shape, and opening it is cheap because Hyperdrive keeps the real connection
 * warm at the edge.
 *
 * Every caller sees the same PoolClient either way, so no service knows or
 * cares which runtime it is on.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  /** Resident pools — Node only. Undefined on Workers. */
  private pool?: Pool;
  private adminPool?: Pool;

  private appUrl!: string;
  private adminUrl!: string;
  private isWorkers = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const appUrl = this.config.get<string>('APP_DATABASE_URL');
    const adminUrl = this.config.get<string>('DATABASE_URL')!;
    const isProd = this.config.get<string>('NODE_ENV') === 'production';
    this.isWorkers = this.config.get<string>('RUNTIME') === 'workers';

    if (!appUrl) {
      // env.validation rejects this combination in production, so reaching
      // here without appUrl means development.
      this.logger.warn(
        'APP_DATABASE_URL not set — tenant plane falling back to DATABASE_URL. ' +
          'Row-Level Security is NOT enforced. Set APP_DATABASE_URL for isolation.',
      );
    }

    this.appUrl = appUrl ?? adminUrl;
    this.adminUrl = adminUrl;

    if (!this.isWorkers) {
      this.pool = new Pool({
        connectionString: this.appUrl,
        max: 10,
        idleTimeoutMillis: 30_000,
      });
      this.adminPool = new Pool({
        connectionString: this.adminUrl,
        max: 5,
        idleTimeoutMillis: 30_000,
      });
      this.pool.on('error', (e) => this.logger.error(`app pool: ${e.message}`));
      this.adminPool.on('error', (e) => this.logger.error(`admin pool: ${e.message}`));
    }

    await this.assertTenantRoleIsRestricted(isProd);
  }

  /**
   * Defence in depth for the tenant plane. A correct APP_DATABASE_URL is not
   * enough on its own — the role it points at must also be unable to bypass
   * RLS. A superuser, or any role with BYPASSRLS, silently defeats every
   * tenant_isolation policy in the schema. Verify at boot rather than
   * discovering it from a cross-tenant data leak.
   *
   * On Workers "boot" means once per isolate, on its first request. That is a
   * round trip on a cold start, and it is worth it: the Hyperdrive binding is
   * configured in a dashboard, far away from this code, and pointing it at the
   * owner role is the single easiest way to lose tenant isolation entirely.
   */
  private async assertTenantRoleIsRestricted(isProd: boolean): Promise<void> {
    let row: { rolsuper: boolean; rolbypassrls: boolean } | undefined;
    try {
      const res = await this.lease('app', (client) =>
        client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
        ),
      );
      row = res.rows[0];
    } catch (e) {
      // Never block startup on the check itself being unavailable.
      this.logger.warn(
        `Could not verify tenant DB role privileges: ${(e as Error).message}`,
      );
      return;
    }
    if (!row || (!row.rolsuper && !row.rolbypassrls)) return;

    const how = row.rolsuper ? 'is a SUPERUSER' : 'has BYPASSRLS';
    const message =
      `The tenant database role ${how}, so Row-Level Security is NOT enforced ` +
      "and every clinic can read every other clinic's data. " +
      'Point APP_DATABASE_URL (or the HYPERDRIVE_APP binding) at the ' +
      'non-superuser app_user role created by migration 0003.';

    if (isProd) throw new Error(message);
    this.logger.warn(message);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pool?.end(), this.adminPool?.end()]);
  }

  /**
   * Borrow one connection on the given plane, run `fn`, and give it back.
   *
   * This is the only place either runtime is named. On Node it leases from the
   * resident pool; on Workers it opens a one-connection pool against
   * Hyperdrive and closes it before returning, so nothing survives the request
   * that created it.
   */
  private async lease<T>(
    plane: 'app' | 'admin',
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!this.isWorkers) {
      const pool = plane === 'app' ? this.pool : this.adminPool;
      if (!pool) throw new Error('DatabaseService used before initialisation');
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    }

    const pool = new Pool({
      connectionString: plane === 'app' ? this.appUrl : this.adminUrl,
      max: 1,
    });
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      return await fn(client);
    } finally {
      client?.release();
      await pool.end().catch(() => undefined);
    }
  }

  /** BEGIN / COMMIT around `fn`, rolling back on any throw. */
  private async transaction<T>(
    plane: 'app' | 'admin',
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.lease(plane, async (client) => {
      try {
        await client.query('BEGIN');
        const r = await fn(client);
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    });
  }

  // ── Tenant plane (RLS-enforced) ──────────────────────────
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ) {
    return this.lease('app', (client) => client.query<T>(text, params));
  }

  async withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction('app', fn);
  }

  async withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.withTransaction(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant_id',
        tenantId,
      ]);
      return fn(client);
    });
  }

  // ── Platform plane (privileged, bypasses RLS) ────────────
  async adminQuery<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ) {
    return this.lease('admin', (client) => client.query<T>(text, params));
  }

  async withAdminTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction('admin', fn);
  }

  async ping(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch (e) {
      // A health check that says "down" without saying why costs an hour of
      // someone's evening. Say why.
      this.logger.error(
        `health ping failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }
}
