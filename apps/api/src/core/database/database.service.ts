import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResultRow } from 'pg';

/**
 * Data-access layer over two pools:
 *
 *  - app pool   (APP_DATABASE_URL, non-superuser) — the tenant plane. RLS is
 *    enforced; use withTenant() so app.current_tenant_id is set.
 *  - admin pool (DATABASE_URL, privileged) — the platform plane. Operates
 *    across all tenants (list/create/suspend) and therefore must bypass RLS.
 *    Reachable only by superadmin-guarded code.
 *
 * In production the platform plane would use a dedicated least-privilege
 * role rather than the migration superuser; for the MVP it reuses DATABASE_URL.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool!: Pool;
  private adminPool!: Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const appUrl = this.config.get<string>('APP_DATABASE_URL');
    const adminUrl = this.config.get<string>('DATABASE_URL')!;
    const isProd = this.config.get<string>('NODE_ENV') === 'production';

    if (!appUrl) {
      // env.validation rejects this combination in production, so reaching
      // here without appUrl means development.
      this.logger.warn(
        'APP_DATABASE_URL not set — tenant plane falling back to DATABASE_URL. ' +
          'Row-Level Security is NOT enforced. Set APP_DATABASE_URL for isolation.',
      );
    }
    this.pool = new Pool({
      connectionString: appUrl ?? adminUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    this.adminPool = new Pool({
      connectionString: adminUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
    });
    this.pool.on('error', (e) => this.logger.error(`app pool: ${e.message}`));
    this.adminPool.on('error', (e) => this.logger.error(`admin pool: ${e.message}`));

    await this.assertTenantRoleIsRestricted(isProd);
  }

  /**
   * Defence in depth for the tenant plane. A correct APP_DATABASE_URL is not
   * enough on its own — the role it points at must also be unable to bypass
   * RLS. A superuser, or any role with BYPASSRLS, silently defeats every
   * tenant_isolation policy in the schema. Verify at boot rather than
   * discovering it from a cross-tenant data leak.
   */
  private async assertTenantRoleIsRestricted(isProd: boolean): Promise<void> {
    let row: { rolsuper: boolean; rolbypassrls: boolean } | undefined;
    try {
      const res = await this.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
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
      'and every clinic can read every other clinic\'s data. ' +
      'Point APP_DATABASE_URL at the non-superuser app_user role created by migration 0003.';

    if (isProd) throw new Error(message);
    this.logger.warn(message);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pool?.end(), this.adminPool?.end()]);
  }

  // ── Tenant plane (RLS-enforced) ──────────────────────────
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ) {
    return this.pool.query<T>(text, params as unknown[]);
  }

  async withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async withTenant<T>(
    tenantId: string,
    fn: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
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
    return this.adminPool.query<T>(text, params as unknown[]);
  }

  async withAdminTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.adminPool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
