import { Global, Module } from '@nestjs/common';
import { DevTenantCheck } from './dev-tenant.check';
import { TenantContextService } from './tenant-context';
import { TenantMiddleware } from './tenant.middleware';

@Global()
@Module({
  providers: [TenantContextService, TenantMiddleware, DevTenantCheck],
  exports: [TenantContextService, TenantMiddleware],
})
export class TenancyModule {}
