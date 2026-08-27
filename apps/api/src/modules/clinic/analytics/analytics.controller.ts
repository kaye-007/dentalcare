import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { AnalyticsService } from './analytics.service';

/* ═══════════════════════ controller ═══════════════════════ */

/**
 * Controller-level permission: every route below requires `reports:read`,
 * which only admin holds. A method that forgot its own decorator would still
 * be guarded.
 */
@Controller('analytics')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('reports:read')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('dashboard')
  dashboard(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.dashboard(from, to);
  }

  @Get('revenue')
  revenue(
    @Query('granularity') granularity?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.revenue(granularity === 'day' ? 'day' : 'month', from, to);
  }

  @Get('by-dentist')
  byDentist(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.byDentist(from, to);
  }

  @Get('by-operatory')
  byOperatory(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.byOperatory(from, to);
  }

  @Get('by-procedure')
  byProcedure(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.byProcedure(from, to);
  }
}
