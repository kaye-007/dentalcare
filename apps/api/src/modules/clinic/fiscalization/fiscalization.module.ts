import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { FiscalSchedulerService } from './fiscal-scheduler.service';
import { FiscalSettingsController, InvoiceFiscalController } from './fiscal.controller';
import { FiscalService } from './fiscal.service';

@Module({
  imports: [AuthModule],
  controllers: [FiscalSettingsController, InvoiceFiscalController],
  providers: [FiscalService, FiscalSchedulerService],
  exports: [FiscalService],
})
export class FiscalizationModule {}
