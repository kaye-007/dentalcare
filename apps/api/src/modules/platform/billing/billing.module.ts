import { Module } from '@nestjs/common';
import { PlatformBillingService } from './billing.service';
import { PlatformBillingController } from './billing.controller';
import { PlatformAuthModule } from '@/modules/platform/auth';
import { PlatformAuditModule } from '../audit/audit.module';

@Module({
  imports: [PlatformAuthModule, PlatformAuditModule],
  controllers: [PlatformBillingController],
  providers: [PlatformBillingService],
})
export class PlatformBillingModule {}
