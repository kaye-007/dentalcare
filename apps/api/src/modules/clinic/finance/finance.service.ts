import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditService, ClinicAuditActor } from '@/core/audit/clinic-audit.service';
import { deriveInvoiceStatus } from './billing-engine';
import { CreateExpenseDto, CreateInvoiceDto, RecordPaymentDto } from './dto/finance.dto';

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
         coalesce((SELECT sum(amount) FROM payments pay
                    WHERE pay.invoice_id = i.id AND pay.voided_at IS NULL), 0) AS paid
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

/**
 * Was a local copy of deriveInvoiceStatus that omitted the zero-total rule —
 * the exact bug billing-engine.ts fixed and kept a test for. Two functions
 * answering the same question is how they drift, so this defers to the engine.
 */
function statusFor(total: number, paid: number): string {
  return deriveInvoiceStatus(total, paid, false);
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
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
      // Voided payments are still listed — struck through, with who and why.
      // Hiding them would defeat the point of not deleting them.
      const pays = await client.query(
        `SELECT pay.id, pay.amount, pay.method, pay.note, pay.paid_at,
                pay.voided_at, pay.void_reason,
                u.full_name AS recorded_by, v.full_name AS voided_by_name
           FROM payments pay
           LEFT JOIN users u ON u.id = pay.created_by
           LEFT JOIN users v ON v.id = pay.voided_by
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

  createInvoice(dto: CreateInvoiceDto, actor: ClinicAuditActor) {
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
            [tenantId, dto.patientId, seq, number, total, dto.issuedAt ?? null, actor.userId],
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
          // The ledger is written inside the SAME transaction as the invoice.
          // A charge that could exist without its ledger entry would make the
          // patient balance quietly wrong, and nothing would report the gap.
          await client.query(
            `INSERT INTO ledger_entries
               (tenant_id, patient_id, invoice_id, entry_type, amount, description,
                occurred_on, created_by)
             VALUES ($1,$2,$3,'charge',$4,$5, coalesce($6::date, CURRENT_DATE), $7)`,
            [tenantId, dto.patientId, invoiceId, total,
             `Invoice ${number}`, dto.issuedAt ?? null, actor.userId],
          );
          await client.query('RELEASE SAVEPOINT invoice_seq');
          await this.audit.record(client, actor, {
            action: 'invoice.created',
            entityType: 'invoice',
            entityId: invoiceId,
            summary: `Issued ${number} for ${total}`,
            metadata: { invoiceNumber: number, total, lineItems: dto.items.length },
          });
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

  cancelInvoice(id: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const cur = await client.query<{ status: string; paid: string; invoice_number: string }>(
        `SELECT status, invoice_number,
                coalesce((SELECT sum(amount) FROM payments
                           WHERE invoice_id = $1 AND voided_at IS NULL), 0) AS paid
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
      await this.audit.record(client, actor, {
        action: 'invoice.cancelled',
        entityType: 'invoice',
        entityId: id,
        summary: `Cancelled ${row.invoice_number}`,
        metadata: { invoiceNumber: row.invoice_number, previousStatus: row.status },
      });
      return this.getInvoiceWithin(client, id);
    });
  }

  /* ── payments ── */
  recordPayment(invoiceId: string, dto: RecordPaymentDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const cur = await client.query<{ status: string; total: number; paid: string }>(
        `SELECT status, total,
                coalesce((SELECT sum(amount) FROM payments
                           WHERE invoice_id = $1 AND voided_at IS NULL), 0) AS paid
           FROM invoices WHERE id = $1 FOR UPDATE`,
        [invoiceId],
      );
      const inv = cur.rows[0];
      if (!inv) throw new NotFoundException('Invoice not found');
      if (inv.status === 'cancelled') throw new BadRequestException('Cannot pay a cancelled invoice');
      const balance = inv.total - Number(inv.paid);
      if (balance <= 0) throw new BadRequestException('This invoice is already fully paid');
      if (dto.amount > balance) {
        throw new BadRequestException(`Amount exceeds the outstanding balance (${balance} EUR)`);
      }
      const { rows: payRows } = await client.query<{ id: string }>(
        `INSERT INTO payments (tenant_id, invoice_id, amount, method, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tenantId, invoiceId, dto.amount, dto.method, dto.note ?? null, actor.userId],
      );

      // Ledger amounts are SIGNED: a payment reduces what the patient owes,
      // so a balance is one SUM rather than a reconciliation.
      const { rows: who } = await client.query<{ patient_id: string; invoice_number: string }>(
        'SELECT patient_id, invoice_number FROM invoices WHERE id = $1', [invoiceId],
      );
      await client.query(
        `INSERT INTO ledger_entries
           (tenant_id, patient_id, invoice_id, payment_id, entry_type, amount,
            description, created_by)
         VALUES ($1,$2,$3,$4,'payment',$5,$6,$7)`,
        [tenantId, who[0]!.patient_id, invoiceId, payRows[0]!.id, -dto.amount,
         `Payment (${dto.method}) for ${who[0]!.invoice_number}`, actor.userId],
      );

      const newPaid = Number(inv.paid) + dto.amount;
      await client.query(
        `UPDATE invoices SET status = $1, updated_at = now() WHERE id = $2`,
        [statusFor(inv.total, newPaid), invoiceId],
      );
      await this.audit.record(client, actor, {
        action: 'payment.recorded',
        entityType: 'payment',
        entityId: payRows[0]!.id,
        summary: `Took ${dto.amount} by ${dto.method} against ${who[0]!.invoice_number}`,
        metadata: {
          amount: dto.amount,
          method: dto.method,
          invoiceId,
          invoiceNumber: who[0]!.invoice_number,
        },
      });
      return this.getInvoiceWithin(client, invoiceId);
    });
  }

  /**
   * Reverse a recorded payment.
   *
   * Not a delete — migration 0018 revoked DELETE on `payments` from the
   * database role, so there is no code path, present or future, that can
   * remove the row. The original stays exactly as it was taken (its amount,
   * method and date are outside the column-level UPDATE grant), gains who
   * voided it and why, and a reversing ledger entry restores the patient's
   * balance. The invoice status is recomputed from what is left standing.
   */
  voidPayment(paymentId: string, reason: string, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const cur = await client.query<{
        invoice_id: string; amount: number; method: string; voided_at: string | null;
        invoice_number: string; patient_id: string; invoice_status: string; total: number;
      }>(
        `SELECT pay.invoice_id, pay.amount, pay.method, pay.voided_at,
                i.invoice_number, i.patient_id, i.status AS invoice_status, i.total
           FROM payments pay
           JOIN invoices i ON i.id = pay.invoice_id
          WHERE pay.id = $1
          FOR UPDATE`,
        [paymentId],
      );
      const pay = cur.rows[0];
      if (!pay) throw new NotFoundException('Payment not found');
      if (pay.voided_at) throw new BadRequestException('This payment is already voided');

      await client.query(
        `UPDATE payments
            SET voided_at = now(), voided_by = $2, void_reason = $3
          WHERE id = $1`,
        [paymentId, actor.userId, reason.trim()],
      );

      // The reversal is a NEW entry, never an edit of the old one: a ledger
      // that can be rewritten is a cache, not evidence. `refund` carries sign
      // +1 in LEDGER_SIGN — the patient owes this again.
      await client.query(
        `INSERT INTO ledger_entries
           (tenant_id, patient_id, invoice_id, payment_id, entry_type, amount,
            description, created_by)
         VALUES ($1,$2,$3,$4,'refund',$5,$6,$7)`,
        [tenantId, pay.patient_id, pay.invoice_id, paymentId, pay.amount,
         `Voided payment (${pay.method}) on ${pay.invoice_number}`, actor.userId],
      );

      const still = await client.query<{ s: string }>(
        `SELECT coalesce(sum(amount),0) AS s FROM payments
          WHERE invoice_id = $1 AND voided_at IS NULL`,
        [pay.invoice_id],
      );
      await client.query(
        `UPDATE invoices SET status = $1, updated_at = now() WHERE id = $2`,
        [
          deriveInvoiceStatus(
            pay.total,
            Number(still.rows[0]!.s),
            pay.invoice_status === 'cancelled',
          ),
          pay.invoice_id,
        ],
      );

      await this.audit.record(client, actor, {
        action: 'payment.voided',
        entityType: 'payment',
        entityId: paymentId,
        summary: `Voided ${pay.amount} (${pay.method}) on ${pay.invoice_number} — ${reason.trim()}`,
        metadata: {
          amount: pay.amount,
          method: pay.method,
          reason: reason.trim(),
          invoiceId: pay.invoice_id,
          invoiceNumber: pay.invoice_number,
        },
      });

      return this.getInvoiceWithin(client, pay.invoice_id);
    });
  }

  listPayments() {
    return this.tx(async (client) => {
      const { rows } = await client.query(
        `SELECT pay.id, pay.amount, pay.method, pay.note, pay.paid_at,
                pay.voided_at, pay.void_reason, v.full_name AS voided_by_name,
                i.id AS invoice_id, i.invoice_number,
                (p.first_name || ' ' || p.last_name) AS patient_name
           FROM payments pay
           JOIN invoices i ON i.id = pay.invoice_id
           JOIN patients p ON p.id = i.patient_id
           LEFT JOIN users v ON v.id = pay.voided_by
          ORDER BY pay.paid_at DESC LIMIT 200`,
      );
      return rows.map((r) => ({
        id: r.id,
        amount: r.amount,
        method: r.method,
        note: r.note,
        paidAt: r.paid_at,
        voidedAt: r.voided_at,
        voidReason: r.void_reason,
        voidedByName: r.voided_by_name,
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
        where.push(`e.category = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT e.id, e.category, e.amount, e.expense_date::text AS expense_date, e.note,
                e.created_at, e.voided_at, e.void_reason, v.full_name AS voided_by_name
           FROM expenses e
           LEFT JOIN users v ON v.id = e.voided_by
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY e.expense_date DESC, e.created_at DESC LIMIT 300`,
        params,
      );
      return rows.map((r) => ({
        id: r.id,
        category: r.category,
        amount: r.amount,
        expenseDate: r.expense_date,
        note: r.note,
        voidedAt: r.voided_at,
        voidReason: r.void_reason,
        voidedByName: r.voided_by_name,
      }));
    });
  }

  createExpense(dto: CreateExpenseDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO expenses (tenant_id, category, amount, expense_date, note, created_by)
         VALUES ($1,$2,$3, coalesce($4::date, CURRENT_DATE), $5, $6)
         RETURNING id, category, amount, expense_date::text AS expense_date, note`,
        [tenantId, dto.category, dto.amount, dto.expenseDate ?? null, dto.note ?? null, actor.userId],
      );
      const r = rows[0]!;
      await this.audit.record(client, actor, {
        action: 'expense.recorded',
        entityType: 'expense',
        entityId: r.id,
        summary: `Recorded ${r.amount} of ${r.category} spending`,
        metadata: { amount: r.amount, category: r.category, expenseDate: r.expense_date },
      });
      return { id: r.id, category: r.category, amount: r.amount, expenseDate: r.expense_date, note: r.note };
    });
  }

  /**
   * Expenses are voided, not deleted — same reasoning as payments, and the
   * same enforcement: 0018 revoked DELETE on `expenses` from the database
   * role. An expense that can vanish is a profit figure nobody can trust.
   */
  voidExpense(id: string, reason: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const cur = await client.query<{
        category: string; amount: number; voided_at: string | null;
      }>(
        'SELECT category, amount, voided_at FROM expenses WHERE id = $1 FOR UPDATE',
        [id],
      );
      const exp = cur.rows[0];
      if (!exp) throw new NotFoundException('Expense not found');
      if (exp.voided_at) throw new BadRequestException('This expense is already voided');

      await client.query(
        `UPDATE expenses
            SET voided_at = now(), voided_by = $2, void_reason = $3
          WHERE id = $1`,
        [id, actor.userId, reason.trim()],
      );
      await this.audit.record(client, actor, {
        action: 'expense.voided',
        entityType: 'expense',
        entityId: id,
        summary: `Voided ${exp.amount} of ${exp.category} spending — ${reason.trim()}`,
        metadata: { amount: exp.amount, category: exp.category, reason: reason.trim() },
      });
      return { voided: true };
    });
  }

  /* ── summary ── */
  /**
   * `includeAggregates` is a data-shaping decision, not a route guard: the
   * front desk legitimately needs the outstanding balance to chase payments,
   * but revenue against expenses is the doctor's alone. Same pattern as
   * StaffController.list withholding salary columns.
   */
  summary(period: 'month' | 'all', includeAggregates: boolean) {
    return this.tx(async (client) => {
      const monthCond = period === 'month';
      const invFilter = monthCond ? `AND date_trunc('month', issued_at) = date_trunc('month', CURRENT_DATE)` : '';
      const payFilter = monthCond ? `AND date_trunc('month', paid_at) = date_trunc('month', CURRENT_DATE)` : '';
      const expFilter = monthCond ? `AND date_trunc('month', expense_date) = date_trunc('month', CURRENT_DATE)` : '';

      const invoiced = await client.query<{ s: string }>(
        `SELECT coalesce(sum(total),0) AS s FROM invoices WHERE status <> 'cancelled' ${invFilter}`,
      );
      const collected = await client.query<{ s: string }>(
        `SELECT coalesce(sum(amount),0) AS s FROM payments
          WHERE voided_at IS NULL ${payFilter}`,
      );
      const outstanding = await client.query<{ s: string }>(
        `SELECT coalesce(sum(i.total - coalesce(p.paid,0)),0) AS s
           FROM invoices i
           LEFT JOIN LATERAL (
             SELECT sum(amount) AS paid FROM payments
              WHERE invoice_id = i.id AND voided_at IS NULL
           ) p ON true
          WHERE i.status IN ('unpaid','partially_paid')`,
      );
      const expenses = await client.query<{ s: string }>(
        `SELECT coalesce(sum(amount),0) AS s FROM expenses
          WHERE voided_at IS NULL ${expFilter}`,
      );
      const base = { period, outstanding: Number(outstanding.rows[0]!.s) };
      if (!includeAggregates) return base;
      return {
        ...base,
        totalInvoiced: Number(invoiced.rows[0]!.s),
        totalCollected: Number(collected.rows[0]!.s),
        totalExpenses: Number(expenses.rows[0]!.s),
      };
    });
  }
}
