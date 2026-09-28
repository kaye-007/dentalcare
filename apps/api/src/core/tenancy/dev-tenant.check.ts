import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '@/core/database/database.service';

/**
 * Says at boot what would otherwise be discovered at the login screen.
 *
 * On localhost there is no subdomain to read, so the clinic comes from
 * DEV_TENANT_SUBDOMAIN. `.env.example` shipped `demo`, and nothing in the
 * ordinary setup path creates a clinic called demo — migrations are schema
 * only, and the demo seed is opt-in. The result is a database that is
 * perfectly healthy and a login that cannot work: TenantMiddleware 404s
 * before AuthService is reached, so the browser shows a failed sign-in for a
 * password that was never compared.
 *
 * The API knows this the moment it starts. There is no reason to make someone
 * find it out one request at a time.
 *
 * Development only, and never fatal. A clinic that does not exist yet is the
 * normal state of a fresh database — the console creates the first one — so this
 * warns and gets out of the way. In production the subdomain comes from the
 * Host header and DEV_TENANT_SUBDOMAIN is ignored entirely, so there is
 * nothing here to check.
 */
@Injectable()
export class DevTenantCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('DevTenant');

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('NODE_ENV') === 'production') return;

    const configured = this.config.get<string>('DEV_TENANT_SUBDOMAIN');
    if (!configured) return;

    const subdomain = configured.toLowerCase();

    let exists: boolean;
    let known: string[] = [];
    try {
      const resolved = await this.db.query<{ id: string }>(
        'SELECT id FROM resolve_tenant($1)',
        [subdomain],
      );
      exists = resolved.rows.length > 0;

      if (!exists) {
        // The privileged connection, because app_user is pinned by RLS to
        // the one clinic a request has established — and this runs outside
        // any request, so that is none of them.
        const all = await this.db.adminQuery<{ subdomain: string }>(
          'SELECT subdomain FROM tenants ORDER BY created_at',
        );
        known = all.rows.map((r) => r.subdomain);
      }
    } catch (e) {
      // An unreachable or unmigrated database is a different problem with its
      // own louder symptoms. Do not add a confusing second one.
      this.logger.debug(`Could not check DEV_TENANT_SUBDOMAIN: ${(e as Error).message}`);
      return;
    }

    if (exists) return;

    this.logger.warn(`No clinic with subdomain "${subdomain}".`);
    this.logger.warn(
      'Every request from the clinic app will 404 in TenantMiddleware, ' +
        'before login is reached.',
    );
    if (known.length > 0) {
      this.logger.warn(`Set DEV_TENANT_SUBDOMAIN in .env to one of: ${known.join(', ')}`);
    } else {
      this.logger.warn(
        'No clinics exist yet. Create one from the platform console, or run:',
      );
      this.logger.warn('  npm run dev:setup            (offers to create one)');
      this.logger.warn('  npm run dev:setup -- --with-demo   (the demo clinic)');
    }
  }
}
