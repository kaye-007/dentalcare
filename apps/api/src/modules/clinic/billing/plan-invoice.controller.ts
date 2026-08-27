import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { BillingService } from './billing.service';
import { GenerateInvoiceDto } from './dto/billing.dto';

/* ═══════════════════════ controllers ═══════════════════════ */

@Controller('treatment-plans/:planId/invoice')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PlanInvoiceController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  @RequirePermissions('invoices:write')
  generate(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: GenerateInvoiceDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.billing.generateFromPlan(planId, dto, auditActor(user));
  }
}
