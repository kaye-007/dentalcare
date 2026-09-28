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
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import {
  CashDepositDto,
  InstallCertificateDto,
  OperatorCodeDto,
  UpdateFiscalSettingsDto,
} from './dto/fiscal.dto';
import { FiscalService } from './fiscal.service';
import { Idempotent } from '@/core/idempotency/idempotency.interceptor';

/** Clinic-level fiscalization: the register, the certificate, the operators, the cash float. */
@Controller('fiscal')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FiscalSettingsController {
  constructor(private readonly fiscal: FiscalService) {}

  @Get('settings')
  @RequirePermissions('settings:read')
  settings() {
    return this.fiscal.getSettings();
  }

  @Patch('settings')
  @RequirePermissions('settings:manage')
  update(@Body() dto: UpdateFiscalSettingsDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.fiscal.updateSettings(dto, auditActor(user));
  }

  /** The key is sealed before it is stored and never returned by any route. */
  @Post('certificate')
  @RequirePermissions('settings:manage')
  certificate(
    @Body() dto: InstallCertificateDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.fiscal.installCertificate(dto, auditActor(user));
  }

  @Patch('operators/:userId')
  @RequirePermissions('settings:manage')
  operator(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: OperatorCodeDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.fiscal.setOperatorCode(userId, dto.operatorCode, auditActor(user));
  }

  /**
   * Everything still owed to the tax authority. Read by the desk that issued
   * them, the accountant and the administrator; `invoices:fiscalize` is what
   * it takes to push one.
   */
  @Get('queue')
  @RequirePermissions('fiscal:read')
  queue() {
    return this.fiscal.queue();
  }

  @Post('queue/:id/retry')
  @RequirePermissions('invoices:fiscalize')
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.fiscal.retryNow(id);
  }

  @Get('cash-deposits')
  @RequirePermissions('invoices:read')
  deposits() {
    return this.fiscal.listCashDeposits();
  }

  @Post('cash-deposits')
  @Idempotent()
  @RequirePermissions('invoices:fiscalize')
  deposit(@Body() dto: CashDepositDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.fiscal.registerCashDeposit(dto, auditActor(user));
  }
}

/** One invoice's registration with the tax authority. */
@Controller('invoices/:id/fiscal')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InvoiceFiscalController {
  constructor(private readonly fiscal: FiscalService) {}

  @Get()
  @RequirePermissions('invoices:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.fiscal.forInvoice(id);
  }

  /** Everything a printed fiscal receipt shows, from the registration itself. */
  @Get('receipt')
  @RequirePermissions('invoices:read')
  receipt(@Param('id', ParseUUIDPipe) id: string) {
    return this.fiscal.receipt(id);
  }

  /**
   * Issue the invoice as a fiscal invoice. Idempotent: a second call returns
   * the registration the first one made, and retries its delivery if pending.
   */
  @Post()
  @Idempotent()
  @RequirePermissions('invoices:fiscalize')
  fiscalize(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.fiscal.fiscalize(id, auditActor(user));
  }
}
