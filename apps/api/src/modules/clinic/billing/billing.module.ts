import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PatientLedgerController } from './patient-ledger.controller';
import { PlanInvoiceController } from './plan-invoice.controller';

@Module({
  imports: [AuthModule],
  controllers: [PlanInvoiceController, PatientLedgerController, BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
