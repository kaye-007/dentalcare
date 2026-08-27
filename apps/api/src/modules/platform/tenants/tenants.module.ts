import { Module } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { PlatformAuthModule } from '@/modules/platform/auth';
import { PlatformAuditModule } from '../audit/audit.module';
import { TenantsController } from './tenants.controller';

@Module({
  imports: [PlatformAuthModule, PlatformAuditModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
