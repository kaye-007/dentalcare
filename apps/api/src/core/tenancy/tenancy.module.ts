import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './tenant-context';
import { TenantMiddleware } from './tenant.middleware';

@Global()
@Module({
  providers: [TenantContextService, TenantMiddleware],
  exports: [TenantContextService, TenantMiddleware],
})
export class TenancyModule {}
