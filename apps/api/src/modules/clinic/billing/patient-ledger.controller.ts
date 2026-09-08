import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { BillingService } from './billing.service';
import { LedgerAdjustmentDto } from './dto/billing.dto';

@Controller('patients/:patientId/ledger')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientLedgerController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @RequirePermissions('invoices:read')
  ledger(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.billing.ledgerFor(patientId);
  }

  /** Write-offs and corrections change what a patient owes — admin only. */
  @Post('adjustments')
  @RequirePermissions('invoices:delete')
  adjust(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: LedgerAdjustmentDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.billing.addAdjustment(patientId, dto, auditActor(user));
  }
}
