import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { LEDGER_ENTRY_TYPES, LEDGER_SIGN } from '@/modules/clinic/finance';
import { BillingService } from './billing.service';

@Controller('billing')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('receivables')
  @RequirePermissions('invoices:read')
  receivables() {
    return this.billing.accountsReceivable();
  }

  @Get('balances')
  @RequirePermissions('invoices:read')
  balances() {
    return this.billing.patientBalances();
  }

  /** The entry types a client may use, so the UI never invents one. */
  @Get('ledger-types')
  @RequirePermissions('invoices:read')
  ledgerTypes() {
    return { types: LEDGER_ENTRY_TYPES, signs: LEDGER_SIGN };
  }
}
