import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { can, normalizeRole } from '@dentalcare/shared';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import {
  CreateStaffDto,
  RecordSalaryPaymentDto,
  ResetStaffPasswordDto,
  UpdateStaffDto,
} from './dto/staff.dto';
import { StaffService } from './staff.service';

/* ── controller ──────────────────────────────────────────── */
@Controller('staff')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  /**
   * All clinic users can read the team list. How each account signs in and
   * its fiscal operator code are for whoever manages staff — a data-shaping
   * decision, so it consults the matrix rather than guarding the route.
   */
  @Get()
  @RequirePermissions('staff:read')
  list(@CurrentUser() user?: AccessTokenPayload) {
    const role = normalizeRole(user?.role);
    return this.staff.list(role !== null && can(role, 'staff:manage'));
  }

  @Get('salary-payments')
  @RequirePermissions('payroll:read')
  salaryLog() {
    return this.staff.listSalaryPayments();
  }

  @Post()
  @RequirePermissions('staff:manage')
  create(@Body() dto: CreateStaffDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.staff.create(dto, auditActor(user));
  }

  @Patch(':id')
  @RequirePermissions('staff:manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.staff.update(id, dto, auditActor(user));
  }

  @Post(':id/password')
  @RequirePermissions('staff:manage')
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetStaffPasswordDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.staff.resetPassword(id, dto.password, auditActor(user));
  }

  /** Lost phone and lost recovery codes. Never for the caller's own account. */
  @Post(':id/mfa/reset')
  @RequirePermissions('staff:manage')
  resetMfa(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.staff.resetMfa(id, auditActor(user));
  }

  @Post(':id/salary-payments')
  @RequirePermissions('payroll:manage')
  recordSalary(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordSalaryPaymentDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.staff.recordSalaryPayment(id, dto, auditActor(user));
  }
}
