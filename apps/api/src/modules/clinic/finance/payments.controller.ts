import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { VoidDto } from './dto/finance.dto';
import { FinanceService } from './finance.service';

@Controller('payments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PaymentsController {
  constructor(private readonly finance: FinanceService) {}

  @Get()
  @RequirePermissions('payments:read')
  list() {
    return this.finance.listPayments();
  }

  /**
   * There is no DELETE here and there never will be: 0018 took the privilege
   * away from the database role, so this is the only way to undo a payment.
   */
  @Post(':id/void')
  @RequirePermissions('payments:void')
  voidPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.finance.voidPayment(id, dto.reason, auditActor(user));
  }
}
