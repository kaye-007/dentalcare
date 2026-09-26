import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { CashDrawerModule } from '@/modules/clinic/cash-drawer';
import { FiscalizationModule } from '@/modules/clinic/fiscalization/fiscalization.module';
import { ExpensesController } from './expenses.controller';
import { FinanceSummaryController } from './finance-summary.controller';
import { FinanceService } from './finance.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoicesController } from './invoices.controller';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [AuthModule, CashDrawerModule, FiscalizationModule],
  controllers: [InvoicesController, PaymentsController, ExpensesController, FinanceSummaryController],
  providers: [FinanceService, InvoicePdfService],
})
export class FinanceModule {}
