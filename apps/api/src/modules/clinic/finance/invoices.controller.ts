import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { can } from '@dentalcare/shared';
import { InvoicePdfService } from './invoice-pdf.service';
import { FiscalService } from '@/modules/clinic/fiscalization/fiscal.service';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { Idempotent } from '@/core/idempotency/idempotency.interceptor';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { CreateInvoiceDto, RecordPaymentDto } from './dto/finance.dto';
import { FinanceService } from './finance.service';

/* ════════ Controllers ════════ */

@Controller('invoices')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InvoicesController {
  constructor(
    private readonly finance: FinanceService,
    private readonly pdfs: InvoicePdfService,
    private readonly fiscal: FiscalService,
  ) {}

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

  /**
   * The printable invoice. A fiscalized invoice always prints its fiscal block;
   * there is no way to ask for a copy without it.
   */
  @Get(':id/pdf')
  @RequirePermissions('invoices:read')
  async pdf(@Param('id', ParseUUIDPipe) id: string) {
    const { bytes, fileName } = await this.pdfs.render(id);
    return new StreamableFile(Buffer.from(bytes), {
      type: 'application/pdf',
      disposition: `inline; filename="${fileName}"`,
    });
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

  /**
   * Take a payment, and issue the document the desk chose with it (0015).
   *
   * The money is recorded first and committed on its own. Registering the
   * invoice with the tax authority is a network call that runs after, so a
   * slow or unreachable CIS cannot roll back a payment the patient has
   * already made — the invoice is simply left for the retry queue, and the
   * response says so.
   */
  @Post(':id/payments')
  @Idempotent()
  @RequirePermissions('payments:write')
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    const actor = auditActor(user);
    const invoice = await this.finance.recordPayment(id, dto, actor);
    if (invoice.documentKind !== 'fiscal') return { ...invoice, fiscal: null, fiscalError: null };

    if (!can(actor.role, 'invoices:fiscalize')) {
      return {
        ...invoice,
        fiscal: null,
        fiscalError: 'This invoice is marked for fiscalization; someone who can issue fiscal invoices must register it.',
      };
    }
    try {
      return { ...invoice, fiscal: await this.fiscal.fiscalize(id, actor), fiscalError: null };
    } catch (e) {
      // The payment stands. The invoice keeps its fiscal intent and shows up
      // unregistered, which is what the queue is for.
      return {
        ...invoice,
        fiscal: null,
        fiscalError: e instanceof HttpException ? messageOf(e) : 'The invoice could not be registered.',
      };
    }
  }
}

/** The human-readable line out of a Nest exception body. */
function messageOf(e: HttpException): string {
  const body = e.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join(', ');
  return typeof message === 'string' ? message : e.message;
}
