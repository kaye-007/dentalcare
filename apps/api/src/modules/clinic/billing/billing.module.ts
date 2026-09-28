import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PatientLedgerController } from './patient-ledger.controller';
import { PlanInvoiceController } from './plan-invoice.controller';
import { PlanEstimateController } from './plan-estimate.controller';
import { EstimateService } from './estimate.service';
import { FxRatesService } from './fx-rates.service';

@Module({
  imports: [AuthModule],
  controllers: [
    PlanInvoiceController,
    PlanEstimateController,
    PatientLedgerController,
    BillingController,
  ],
  providers: [BillingService, EstimateService, FxRatesService],
  exports: [BillingService],
})
export class BillingModule {}
