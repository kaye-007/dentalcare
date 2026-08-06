import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type as TT } from 'class-transformer';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OwnerGuard } from '../auth/owner.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessTokenPayload } from '../auth/auth.service';
import { AuthModule } from '../auth/auth.module';

/* ════════ DTOs ════════ */
export class LineItemDto {
  @IsOptional() @IsUUID()
  treatmentId?: string;

  @IsString() @MinLength(1, { message: 'Line description is required' }) @MaxLength(200)
  description!: string;

  @IsInt() @Min(1)
  quantity!: number;

  @IsInt() @Min(0)
  unitPrice!: number;
}

export class CreateInvoiceDto {
  @IsUUID()
  patientId!: string;

  @IsOptional() @IsISO8601()
  issuedAt?: string;

  @IsArray() @ArrayMinSize(1, { message: 'An invoice needs at least one line item' })
  @ValidateNested({ each: true }) @TT(() => LineItemDto)
  items!: LineItemDto[];
}

export class RecordPaymentDto {
  @IsInt() @Min(1, { message: 'Amount must be positive' })
  amount!: number;

  @IsIn(['cash', 'card', 'bank'])
  method!: 'cash' | 'card' | 'bank';

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

export class CreateExpenseDto {
  @IsIn(['rent', 'materials', 'utilities', 'salaries', 'lab', 'other'])
  category!: 'rent' | 'materials' | 'utilities' | 'salaries' | 'lab' | 'other';

  @IsInt() @Min(1)
  amount!: number;

  @IsOptional() @IsISO8601()
  expenseDate?: string;

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

/* ════════ Service ════════ */
interface InvRow {
  id: string;
  invoice_number: string;
  status: string;
  total: number;
  issued_at: string;
  patient_id: string;
  patient_name: string;
  paid: string | number;
}

const INV_SELECT = `
  SELECT i.id, i.invoice_number, i.status, i.total, i.issued_at::text AS issued_at,
         i.patient_id, (p.first_name || ' ' || p.last_name) AS patient_name,
         coalesce((SELECT sum(amount) FROM payments pay WHERE pay.invoice_id = i.id), 0) AS paid
    FROM invoices i
    JOIN patients p ON p.id = i.patient_id`;

const mapInv = (r: InvRow) => ({
  id: r.id,
  invoiceNumber: r.invoice_number,
  status: r.status,
  total: r.total,
  paid: Number(r.paid),
  balance: r.total - Number(r.paid),
  issuedAt: r.issued_at,
  patientId: r.patient_id,
  patientName: r.patient_name,
});

/** Attempts at allocating a per-tenant invoice number before giving up. */
const MAX_SEQ_ATTEMPTS = 2;

function statusFor(total: number, paid: number): string {
  if (paid <= 0) return 'unpaid';
  if (paid >= total) return 'paid';
  return 'partially_paid';
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /* ── invoices ── */
  listInvoices(opts: { q?: string; status?: string }) {
    return this.tx(async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.status && ['unpaid', 'partially_paid', 'paid', 'cancelled'].includes(opts.status)) {
        params.push(opts.status);
        where.push(`i.status = $${params.length}`);
      }
      if (opts.q?.trim()) {
        params.push(`%${opts.q.trim()}%`);
        const k = params.length;
        where.push(`(i.invoice_number ILIKE $${k} OR (p.first_name || ' ' || p.last_name) ILIKE $${k})`);
      }
      const { rows } = await client.query<InvRow>(
        `${INV_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY i.seq DESC LIMIT 200`,
        params,
      );
      return rows.map(mapInv);
    });
  }

  getInvoice(id: string) {
    return this.tx(async (client) => {
      const inv = await client.query<InvRow>(`${INV_SELECT} WHERE i.id = $1`, [id]);
      if (!inv.rows[0]) throw new NotFoundException('Invoice not found');
      const items = await client.query(
        `SELECT li.id, li.description, li.quantity, li.unit_price, li.amount,
                li.treatment_id, t.name AS treatment_name
           FROM invoice_line_items li
           LEFT JOIN treatments t ON t.id = li.treatment_id
          WHERE li.invoice_id = $1 ORDER BY li.id`,
        [id],
      );
      const pays = await client.query(
        `SELECT pay.id, pay.amount, pay.method, pay.note, pay.paid_at, u.full_name AS recorded_by
           FROM payments pay LEFT JOIN users u ON u.id = pay.created_by
          WHERE pay.invoice_id = $1 ORDER BY pay.paid_at DESC`,
        [id],
      );
      return {
        ...mapInv(inv.rows[0]),
        items: items.rows.map((r) => ({
          id: r.id,
          description: r.description,
          quantity: r.quantity,
          unitPrice: r.unit_price,
          amount: r.amount,
          treatmentId: r.treatment_id,
          treatmentName: r.treatment_name,
        })),
        payments: pays.rows.map((r) => ({
          id: r.id,
          amount: r.amount,
          method: r.method,
          note: r.note,
          paidAt: r.paid_at,
          recordedBy: r.recorded_by,
        })),
      };
    });
  }

  createInvoice(dto: CreateInvoiceDto, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const pat = await client.query('SELECT 1 FROM patients WHERE id = $1', [dto.patientId]);
      if (!pat.rowCount) throw new NotFoundException('Patient not found');
      for (const it of dto.items) {
        if (it.treatmentId) {
          const t = await client.query('SELECT 1 FROM treatments WHERE id = $1', [it.treatmentId]);
          if (!t.rowCount) throw new NotFoundException('Treatment not found');
        }
      }
      const total = dto.items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);

      // Per-tenant sequential number, retried on a concurrent clash.
      //
      // Each attempt runs inside a SAVEPOINT. Without one the retry could not
      // work: a 23505 aborts the enclosing transaction, so every following
      // statement fails with 25P02 ("current transaction is aborted") and the
      // second attempt turned a recoverable conflict into an opaque 500.
      // ROLLBACK TO SAVEPOINT makes the transaction usable again.
      for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++) {
        await client.query('SAVEPOINT invoice_seq');
        try {
          const seqRes = await client.query<{ next: number }>(
            'SELECT coalesce(max(seq), 0) + 1 AS next FROM invoices',
          );
          const seq = Number(seqRes.rows[0]!.next);
          const number = `INV-${String(seq).padStart(4, '0')}`;
          const ins = await client.query<{ id: string }>(
            `INSERT INTO invoices (tenant_id, patient_id, seq, invoice_number, total, issued_at, created_by)
             VALUES ($1,$2,$3,$4,$5, coalesce($6::date, CURRENT_DATE), $7) RETURNING id`,
            [tenantId, dto.patientId, seq, number, total, dto.issuedAt ?? null, userId],
          );
          const invoiceId = ins.rows[0]!.id;
          for (const it of dto.items) {
            await client.query(
              `INSERT INTO invoice_line_items
                 (tenant_id, invoice_id, treatment_id, description, quantity, unit_price, amount)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [tenantId, invoiceId, it.treatmentId ?? null, it.description,
               it.quantity, it.unitPrice, it.quantity * it.unitPrice],
            );
          }
          await client.query('RELEASE SAVEPOINT invoice_seq');
          return this.getInvoiceWithin(client, invoiceId);
        } catch (err: unknown) {
          await client.query('ROLLBACK TO SAVEPOINT invoice_seq');
          const isClash = (err as { code?: string }).code === '23505';
          if (isClash && attempt < MAX_SEQ_ATTEMPTS - 1) continue;
          if (isClash) break;
          throw err;
        }
      }
      throw new BadRequestException('Could not allocate an invoice number, please retry');
    });
  }

  private async getInvoiceWithin(client: PoolClient, id: string) {
    const { rows } = await client.query<InvRow>(`${INV_SELECT} WHERE i.id = $1`, [id]);
    return mapInv(rows[0]!);
  }

  cancelInvoice(id: string) {
    return this.tx(async (client) => {
      const cur = await client.query<{ status: string; paid: string }>(
        `SELECT status, coalesce((SELECT sum(amount) FROM payments WHERE invoice_id = $1), 0) AS paid
           FROM invoices WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = cur.rows[0];
      if (!row) throw new NotFoundException('Invoice not found');
      if (row.status === 'cancelled') throw new BadRequestException('Invoice is already cancelled');
      if (Number(row.paid) > 0) {
        throw new BadRequestException('An invoice with recorded payments cannot be cancelled');
      }
      await client.query(
        `UPDATE invoices SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [id],
      );
      return this.getInvoiceWithin(client, id);
    });
  }

  /* ── payments ── */
  recordPayment(invoiceId: string, dto: RecordPaymentDto, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const cur = await client.query<{ status: string; total: number; paid: string }>(
        `SELECT status, total,
                coalesce((SELECT sum(amount) FROM payments WHERE invoice_id = $1), 0) AS paid
           FROM invoices WHERE id = $1 FOR UPDATE`,
        [invoiceId],
      );
      const inv = cur.rows[0];
      if (!inv) throw new NotFoundException('Invoice not found');
      if (inv.status === 'cancelled') throw new BadRequestException('Cannot pay a cancelled invoice');
      const balance = inv.total - Number(inv.paid);
      if (balance <= 0) throw new BadRequestException('This invoice is already fully paid');
      if (dto.amount > balance) {
        throw new BadRequestException(`Amount exceeds the outstanding balance (${balance} L)`);
      }
      await client.query(
        `INSERT INTO payments (tenant_id, invoice_id, amount, method, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, invoiceId, dto.amount, dto.method, dto.note ?? null, userId],
      );
      const newPaid = Number(inv.paid) + dto.amount;
      await client.query(
        `UPDATE invoices SET status = $1, updated_at = now() WHERE id = $2`,
        [statusFor(inv.total, newPaid), invoiceId],
      );
      return this.getInvoiceWithin(client, invoiceId);
    });
  }

  listPayments() {
    return this.tx(async (client) => {
      const { rows } = await client.query(
        `SELECT pay.id, pay.amount, pay.method, pay.note, pay.paid_at,
                i.id AS invoice_id, i.invoice_number,
                (p.first_name || ' ' || p.last_name) AS patient_name
           FROM payments pay
           JOIN invoices i ON i.id = pay.invoice_id
           JOIN patients p ON p.id = i.patient_id
          ORDER BY pay.paid_at DESC LIMIT 200`,
      );
      return rows.map((r) => ({
        id: r.id,
        amount: r.amount,
        method: r.method,
        note: r.note,
        paidAt: r.paid_at,
        invoiceId: r.invoice_id,
        invoiceNumber: r.invoice_number,
        patientName: r.patient_name,
      }));
    });
  }

  /* ── expenses ── */
  listExpenses(opts: { category?: string }) {
    return this.tx(async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.category && opts.category !== 'all') {
        params.push(opts.category);
        where.push(`category = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT id, category, amount, expense_date::text AS expense_date, note, created_at
           FROM expenses ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY expense_date DESC, created_at DESC LIMIT 300`,
        params,
      );
      return rows.map((r) => ({
        id: r.id,
        category: r.category,
        amount: r.amount,
        expenseDate: r.expense_date,
        note: r.note,
      }));
    });
  }

  createExpense(dto: CreateExpenseDto, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO expenses (tenant_id, category, amount, expense_date, note, created_by)
         VALUES ($1,$2,$3, coalesce($4::date, CURRENT_DATE), $5, $6)
         RETURNING id, category, amount, expense_date::text AS expense_date, note`,
        [tenantId, dto.category, dto.amount, dto.expenseDate ?? null, dto.note ?? null, userId],
      );
      const r = rows[0]!;
      return { id: r.id, category: r.category, amount: r.amount, expenseDate: r.expense_date, note: r.note };
    });
  }

  deleteExpense(id: string) {
    return this.tx(async (client) => {
      const res = await client.query('DELETE FROM expenses WHERE id = $1', [id]);
      if (!res.rowCount) throw new NotFoundException('Expense not found');
      return { deleted: true };
    });
  }

  /* ── summary ── */
  summary(period: 'month' | 'all') {
    return this.tx(async (client) => {
      const monthCond = period === 'month';
      const invFilter = monthCond ? `AND date_trunc('month', issued_at) = date_trunc('month', CURRENT_DATE)` : '';
      const payFilter = monthCond ? `AND date_trunc('month', paid_at) = date_trunc('month', CURRENT_DATE)` : '';
      const expFilter = monthCond ? `AND date_trunc('month', expense_date) = date_trunc('month', CURRENT_DATE)` : '';

      const invoiced = await client.query<{ s: string }>(
        `SELECT coalesce(sum(total),0) AS s FROM invoices WHERE status <> 'cancelled' ${invFilter}`,
      );
      const collected = await client.query<{ s: string }>(
        `SELECT coalesce(sum(amount),0) AS s FROM payments WHERE true ${payFilter}`,
      );
      const outstanding = await client.query<{ s: string }>(
        `SELECT coalesce(sum(i.total - coalesce(p.paid,0)),0) AS s
           FROM invoices i
           LEFT JOIN LATERAL (
             SELECT sum(amount) AS paid FROM payments WHERE invoice_id = i.id
           ) p ON true
          WHERE i.status IN ('unpaid','partially_paid')`,
      );
      const expenses = await client.query<{ s: string }>(
        `SELECT coalesce(sum(amount),0) AS s FROM expenses WHERE true ${expFilter}`,
      );
      return {
        period,
        totalInvoiced: Number(invoiced.rows[0]!.s),
        totalCollected: Number(collected.rows[0]!.s),
        outstanding: Number(outstanding.rows[0]!.s),
        totalExpenses: Number(expenses.rows[0]!.s),
      };
    });
  }
}

/* ════════ Controllers ════════ */
function uid(user?: AccessTokenPayload): string {
  if (!user) throw new UnauthorizedException();
  return user.sub;
}

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private readonly finance: FinanceService) {}

  @Get()
  list(@Query('q') q?: string, @Query('status') status?: string) {
    return this.finance.listInvoices({ q, status });
  }

  @Get(':id')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.finance.getInvoice(id);
  }

  @Post()
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.finance.createInvoice(dto, uid(user));
  }

  @Patch(':id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.finance.cancelInvoice(id);
  }

  @Post(':id/payments')
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.finance.recordPayment(id, dto, uid(user));
  }
}

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly finance: FinanceService) {}

  @Get()
  list() {
    return this.finance.listPayments();
  }
}

@Controller('expenses')
@UseGuards(JwtAuthGuard)
export class ExpensesController {
  constructor(private readonly finance: FinanceService) {}

  @Get()
  list(@Query('category') category?: string) {
    return this.finance.listExpenses({ category });
  }

  @Post()
  create(@Body() dto: CreateExpenseDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.finance.createExpense(dto, uid(user));
  }

  @Delete(':id')
  @UseGuards(OwnerGuard)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.finance.deleteExpense(id);
  }
}

@Controller('finance')
@UseGuards(JwtAuthGuard)
export class FinanceSummaryController {
  constructor(private readonly finance: FinanceService) {}

  @Get('summary')
  summary(@Query('period') period?: string) {
    return this.finance.summary(period === 'all' ? 'all' : 'month');
  }
}

@Module({
  imports: [AuthModule],
  controllers: [InvoicesController, PaymentsController, ExpensesController, FinanceSummaryController],
  providers: [FinanceService, OwnerGuard],
})
export class FinanceModule {}
