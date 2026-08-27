import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { ExpensesController } from './expenses.controller';
import { FinanceSummaryController } from './finance-summary.controller';
import { FinanceService } from './finance.service';
import { InvoicesController } from './invoices.controller';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [AuthModule],
  controllers: [InvoicesController, PaymentsController, ExpensesController, FinanceSummaryController],
  providers: [FinanceService],
})
export class FinanceModule {}
