import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NestMiddleware,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import { DatabaseService } from '../database/database.service';
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
      throw new BadRequestException(
        'Could not determine the clinic for this request.',
      );
    }

    const { rows } = await this.db.query<{ id: string; status: string }>(
      'SELECT id, status FROM resolve_tenant($1)',
      [subdomain],
    );
    const tenant = rows[0];
    if (!tenant) {
      throw new NotFoundException('Clinic not found.');
    }
    if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
      throw new ForbiddenException({
        code: 'tenant_suspended',
        message: "This clinic's access is currently suspended.",
      });
    }

    // Everything downstream runs inside this tenant's context.
    this.ctx.run({ id: tenant.id, subdomain, status: tenant.status }, () =>
      next(),
    );
  }

  /**
   * Production: the subdomain of the Host (avicena.dentalcare.app -> avicena).
   * Development: an X-Tenant-Subdomain header, or the DEV_TENANT_SUBDOMAIN
   * fallback, so localhost works without editing the hosts file.
   */
  private resolveSubdomain(req: Request): string | null {
    const isProd = this.config.get<string>('NODE_ENV') === 'production';

    if (!isProd) {
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
}
