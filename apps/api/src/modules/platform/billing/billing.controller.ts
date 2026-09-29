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
import { Idempotent } from '@/core/idempotency/idempotency.interceptor';

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

  // Each of these moves money in the vendor's books, so each requires an
  // Idempotency-Key (kept in platform_idempotency_keys, 0026). They were
  // already safe against a repeat — pay and void lock the row and refuse a
  // second transition, run is ON CONFLICT DO NOTHING — and the key turns
  // that refusal into the first answer, replayed.
  @Post('run')
  @Idempotent()
  run(@Body() dto: RunBillingDto, @CurrentAdmin() admin?: PlatformTokenPayload) {
    return this.billing.run(dto, actorOf(admin));
  }

  @Post('invoices/:id/pay')
  @Idempotent()
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkPaidDto,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.billing.markPaid(id, dto, actorOf(admin));
  }

  @Post('invoices/:id/void')
  @Idempotent()
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.billing.void(id, dto, actorOf(admin));
  }
}
