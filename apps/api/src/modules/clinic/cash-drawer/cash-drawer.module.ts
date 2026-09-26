import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { FiscalizationModule } from '@/modules/clinic/fiscalization/fiscalization.module';
import { CashDrawerController } from './cash-drawer.controller';
import { CashDrawerService } from './cash-drawer.service';

/**
 * Exported so FinanceService can put a cash payment into the receptionist's
 * session inside the payment's own transaction.
 */
@Module({
  imports: [AuthModule, FiscalizationModule],
  controllers: [CashDrawerController],
  providers: [CashDrawerService],
  exports: [CashDrawerService],
})
export class CashDrawerModule {}
