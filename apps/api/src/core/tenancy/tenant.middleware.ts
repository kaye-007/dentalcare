import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NestMiddleware,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from './tenant-context';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly db: DatabaseService,
    private readonly ctx: TenantContextService,
    private readonly config: ConfigService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const subdomain = this.resolveSubdomain(req);
    if (!subdomain) {
      throw new BadRequestException('Could not determine the clinic for this request.');
    }

    const { rows } = await this.db.query<{
      id: string;
      status: string;
      trial_ends_at: Date | null;
    }>('SELECT id, status, trial_ends_at FROM resolve_tenant($1)', [subdomain]);
    const tenant = rows[0];
    if (!tenant) {
      throw new NotFoundException(this.clinicNotFound(subdomain, req));
    }
    // Allowlist, not denylist: any status other than 'active' loses access.
    // Migration 0004 replaced ('trial','active','suspended','cancelled') with
    // ('active','suspended','archived'); the previous denylist still named
    // 'cancelled' (now unreachable) and never named 'archived', so archiving a
    // clinic in the admin console revoked nothing. Failing closed also means a
    // future status is denied by default rather than silently permitted.
    if (tenant.status !== 'active') {
      throw new ForbiddenException({
        code: 'tenant_suspended',
        message: "This clinic's access is currently suspended.",
      });
    }

    // A trial that has run out is NOT a suspension: the clinic still signs in
    // and still sees everything it entered. ReadOnlyGuard turns that into a
    // refusal on writes. Comparing against the database's own clock would be
    // better still, but resolve_tenant hands back an absolute timestamp and
    // the process clock is the same one every other expiry here uses.
    const trialEndsAt = tenant.trial_ends_at
      ? new Date(tenant.trial_ends_at).toISOString()
      : null;
    const readOnly = trialEndsAt !== null && new Date(trialEndsAt) < new Date();

    // Everything downstream runs inside this tenant's context.
    this.ctx.run(
      { id: tenant.id, subdomain, status: tenant.status, trialEndsAt, readOnly },
      () => next(),
    );
  }

  /**
   * "Clinic not found." was true and useless.
   *
   * The overwhelmingly common way to see it is local: .env ships
   * DEV_TENANT_SUBDOMAIN=demo, nothing in ordinary setup creates a clinic
   * called demo, and so every login on localhost 404s here — before
   * AuthService runs, before a password is ever compared. Read as a login
   * failure it points at bcrypt, at the seed, at the token; it is none of
   * those, and the message gave no way to find that out.
   *
   * So in development it says which subdomain was looked up, where that
   * subdomain came from, and what to do about it. In production it stays
   * exactly as terse as it was: the caller controls the Host, and confirming
   * which clinics do and do not exist is free tenant enumeration.
   */
  private clinicNotFound(subdomain: string, req: Request): string {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      return 'Clinic not found.';
    }

    const fromHeader =
      this.tenantHeaderAllowed() && Boolean(req.headers['x-tenant-subdomain']);
    const source = fromHeader
      ? 'the X-Tenant-Subdomain header'
      : this.config.get<string>('DEV_TENANT_SUBDOMAIN')?.toLowerCase() === subdomain
        ? 'DEV_TENANT_SUBDOMAIN in .env'
        : 'the Host header';

    return (
      `No clinic with subdomain "${subdomain}" (from ${source}). ` +
      'Set DEV_TENANT_SUBDOMAIN to a clinic that exists, or create one: ' +
      'npm run dev:setup'
    );
  }

  /**
   * Production: the subdomain of the Host (avicena.dentalcare.app -> avicena).
   * Development: an X-Tenant-Subdomain header, or the DEV_TENANT_SUBDOMAIN
   * fallback, so localhost works without editing the hosts file.
   *
   * The header lets a client choose which clinic it is talking to, so it is
   * gated on an explicit opt-in (ALLOW_TENANT_HEADER=1) and hard-disabled in
   * production. Previously it was enabled by the absence of
   * NODE_ENV=production, which fails open: a deploy that forgot one variable
   * quietly accepted client-chosen tenants. Token-to-tenant binding still
   * blocked cross-tenant reads, but it allowed enumerating clinics and probing
   * credentials against any of them.
   */
  private resolveSubdomain(req: Request): string | null {
    if (this.tenantHeaderAllowed()) {
      const header = req.headers['x-tenant-subdomain'];
      if (header) {
        return String(Array.isArray(header) ? header[0] : header).toLowerCase();
      }
      const devTenant = this.config.get<string>('DEV_TENANT_SUBDOMAIN');
      if (devTenant) return devTenant.toLowerCase();
    }

    const host = (req.headers.host ?? '').split(':')[0]!;
    const labels = host.split('.');
    if (labels.length >= 3 && labels[0] && labels[0] !== 'www') {
      return labels[0].toLowerCase();
    }
    return null;
  }

  /** Never honour the client-supplied tenant header in production. */
  private tenantHeaderAllowed(): boolean {
    if (this.config.get<string>('NODE_ENV') === 'production') return false;
    return this.config.get<string>('ALLOW_TENANT_HEADER') === '1';
  }
}
