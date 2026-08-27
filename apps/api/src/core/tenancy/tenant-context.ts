import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantCtx {
  id: string;
  subdomain: string;
  status: string;
  /** null for a paying clinic; a date for one on trial. */
  trialEndsAt: string | null;
  /**
   * The trial ran out. The clinic keeps every read — their own data is the
   * best argument for paying — and loses every write. Resolved once per
   * request from `trialEndsAt` rather than stored, so there is no second
   * flag to fall out of step with the date.
   */
  readOnly: boolean;
}

/**
 * Ambient per-request tenant context. Set once by TenantMiddleware and read
 * anywhere downstream (guards, services) without threading it through every
 * call. The database layer uses the id to scope queries via RLS.
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantCtx>();

  run<T>(ctx: TenantCtx, fn: () => T): T {
    return this.als.run(ctx, fn);
  }

  get(): TenantCtx | undefined {
    return this.als.getStore();
  }

  getTenantId(): string | undefined {
    return this.als.getStore()?.id;
  }

  getRequiredTenantId(): string {
    const id = this.getTenantId();
    if (!id) throw new Error('Tenant context is not available for this request');
    return id;
  }

  /** True only inside a request whose clinic is past its trial. */
  isReadOnly(): boolean {
    return this.als.getStore()?.readOnly ?? false;
  }
}
