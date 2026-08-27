import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { AuditController } from './audit.controller';

@Module({
  imports: [AuthModule],
  controllers: [AuditController],
})
export class AuditModule {}
