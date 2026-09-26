import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { EstimateService } from './estimate.service';

/** A treatment plan as a printable estimate, optionally with a second currency. */
@Controller('treatment-plans/:planId/estimate')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PlanEstimateController {
  constructor(private readonly estimates: EstimateService) {}

  /**
   * ?currency=EUR for a second currency, ?currency=none for none; omitted, the
   * clinic's own choice in Settings → Finance.
   */
  @Get()
  @RequirePermissions('clinical:read')
  estimate(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Query('currency') currency?: string,
  ) {
    return this.estimates.forPlan(planId, currency);
  }
}
