import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { PlatformBillingService } from './billing.service';
import { MarkPaidDto, RunBillingDto, VoidInvoiceDto } from './dto/billing.dto';
import {
  CurrentAdmin,
  PlatformJwtGuard,
  PlatformTokenPayload,
} from '@/modules/platform/auth';
import { PlatformAuditActor } from '../audit/audit.service';

function actorOf(admin?: PlatformTokenPayload): PlatformAuditActor {
  if (!admin) throw new UnauthorizedException();
  return { type: 'platform_admin', id: admin.sub, label: admin.email };
}

@Controller('platform/billing')
@UseGuards(PlatformJwtGuard)
export class PlatformBillingController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Get('summary')
  summary() {
    return this.billing.summary();
  }

  @Get('invoices')
  list(
    @Query('status') status?: string,
    @Query('tenantId') tenantId?: string,
    @Query('overdue') overdue?: string,
  ) {
    return this.billing.list({ status, tenantId, overdue: overdue === 'true' });
  }

  @Get('tenants/:id/invoices')
  forTenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.forTenant(id);
  }

  @Post('run')
  run(@Body() dto: RunBillingDto, @CurrentAdmin() admin?: PlatformTokenPayload) {
    return this.billing.run(dto, actorOf(admin));
  }

  @Post('invoices/:id/pay')
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkPaidDto,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.billing.markPaid(id, dto, actorOf(admin));
  }

  @Post('invoices/:id/void')
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.billing.void(id, dto, actorOf(admin));
  }
}
