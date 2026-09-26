import { Module } from '@nestjs/common';
import { PlatformAuthModule } from '@/modules/platform/auth';
import { PlatformAuditModule } from '../audit/audit.module';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

@Module({
  imports: [PlatformAuthModule, PlatformAuditModule],
  controllers: [PlansController],
  providers: [PlansService],
})
export class PlansModule {}
