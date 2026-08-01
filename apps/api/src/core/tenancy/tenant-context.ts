import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantCtx {
  id: string;
  subdomain: string;
  status: string;
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
}
