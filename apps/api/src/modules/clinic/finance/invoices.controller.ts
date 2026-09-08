import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { CreateInvoiceDto, RecordPaymentDto } from './dto/finance.dto';
import { FinanceService } from './finance.service';

/* ════════ Controllers ════════ */

@Controller('invoices')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InvoicesController {
  constructor(private readonly finance: FinanceService) {}

  @Get()
  @RequirePermissions('invoices:read')
  list(@Query('q') q?: string, @Query('status') status?: string) {
    return this.finance.listInvoices({ q, status });
  }

  @Get(':id')
  @RequirePermissions('invoices:read')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.finance.getInvoice(id);
  }

  @Post()
  @RequirePermissions('invoices:write')
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.finance.createInvoice(dto, auditActor(user));
  }

  /**
   * Reception may cancel, deliberately: cancelInvoice refuses outright once
   * any payment exists, so this can only ever void an unbilled document —
   * her own typo, not money that came in. R2 puts every use of it in the
   * clinic audit log.
   */
  @Patch(':id/cancel')
  @RequirePermissions('invoices:write')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.finance.cancelInvoice(id, auditActor(user));
  }

  @Post(':id/payments')
  @RequirePermissions('payments:write')
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.finance.recordPayment(id, dto, auditActor(user));
  }
}
