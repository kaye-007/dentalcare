import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { can, normalizeRole } from '@dentalcare/shared';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { FinanceService } from './finance.service';

@Controller('finance')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FinanceSummaryController {
  constructor(private readonly finance: FinanceService) {}

  @Get('summary')
  @RequirePermissions('invoices:read')
  summary(@Query('period') period?: string, @CurrentUser() user?: AccessTokenPayload) {
    const role = normalizeRole(user?.role);
    const full = role !== null && can(role, 'reports:read');
    return this.finance.summary(period === 'all' ? 'all' : 'month', full);
  }
}
