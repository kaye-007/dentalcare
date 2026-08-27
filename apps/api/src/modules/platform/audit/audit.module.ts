import { Module } from '@nestjs/common';
import { PlatformAuditService } from './audit.service';

@Module({
  providers: [PlatformAuditService],
  exports: [PlatformAuditService],
})
export class PlatformAuditModule {}
