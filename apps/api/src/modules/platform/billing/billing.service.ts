import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '@/core/database/database.service';
import { PlatformAuditActor, PlatformAuditService } from '../audit/audit.service';
import { MarkPaidDto, RunBillingDto, VoidInvoiceDto } from './dto/billing.dto';

/**
 * Subscription billing: what each clinic owes the vendor, and whether it paid.
 *
 * The console could already show a plan and its price. That is an intention.
 * This service deals in facts — an invoice for a named period, a due date, and
 * either a payment against it or an age.
 */

/** Net 14: the clinic has two weeks from the day the period is invoiced. */
const PAYMENT_TERMS_DAYS = 14;

/**
 * The three date columns are rendered as text, not left as `date`.
 *
 * node-postgres turns a `date` into a JS Date at LOCAL midnight, which then
 * serialises to an instant — `2026-09-15T04:00:00.000Z` for a due date of the
 * 15th. Two things break: comparing it to a 'YYYY-MM-DD' string is always
 * false (so nothing is ever overdue), and a browser west of UTC renders the
 * day before. A due date has no time and no zone; sending one invents both.
 */
const INVOICE_COLUMNS = `
  si.id, si.number, si.tenant_id,
  to_char(si.period_start, 'YYYY-MM-DD') AS period_start,
  to_char(si.period_end,   'YYYY-MM-DD') AS period_end,
  to_char(si.due_date,     'YYYY-MM-DD') AS due_date,
  si.plan_code, si.plan_name, si.amount, si.currency, si.status,
  si.issued_at, si.paid_at, si.paid_amount, si.method,
  si.reference, si.note,
  t.name AS tenant_name, t.subdomain, t.status AS tenant_status`;

interface InvoiceRow {
  id: string;
  number: string;
  tenant_id: string;
  period_start: string;
  period_end: string;
  plan_code: string | null;
  plan_name: string | null;
  amount: number;
  currency: string;
  status: string;
  issued_at: Date;
  due_date: string;
  paid_at: Date | null;
  paid_amount: number | null;
  method: string | null;
  reference: string | null;
  note: string | null;
  tenant_name: string;
  subdomain: string;
  tenant_status: string;
}

/**
 * Overdue is derived, never stored. A stored flag would be wrong every night
 * between midnight and whenever a job next ran; a date comparison is right
 * whenever someone happens to look.
 */
function mapInvoice(r: InvoiceRow, today: string) {
  const overdue = r.status === 'open' && r.due_date < today;
  const daysLate = overdue
    ? Math.floor((Date.parse(today) - Date.parse(r.due_date)) / 86_400_000)
    : 0;
  return {
    id: r.id,
    number: r.number,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    subdomain: r.subdomain,
    tenantStatus: r.tenant_status,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    planCode: r.plan_code,
    planName: r.plan_name,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    issuedAt: r.issued_at,
    dueDate: r.due_date,
    paidAt: r.paid_at,
    paidAmount: r.paid_amount,
    method: r.method,
    reference: r.reference,
    note: r.note,
    overdue,
    daysLate,
  };
}

@Injectable()
export class PlatformBillingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: PlatformAuditService,
  ) {}

  private async today(): Promise<string> {
    const { rows } = await this.db.adminQuery<{ d: string }>(
      `SELECT to_char(current_date, 'YYYY-MM-DD') AS d`,
    );
    return rows[0]!.d;
  }

  /** The money view of the fleet: billed, collected, and what is late. */
  async summary() {
    const { rows } = await this.db.adminQuery<{
      mrr: string;
      open_count: number;
      open_total: string;
      overdue_count: number;
      overdue_total: string;
      paid_this_month: string;
      invoiced_this_month: string;
      unbilled_clinics: number;
    }>(
      `SELECT
         (SELECT coalesce(sum(p.price_monthly), 0)
            FROM tenants t JOIN plans p ON p.id = t.plan_id
           WHERE t.status = 'active' AND t.deleted_at IS NULL
             AND (t.trial_ends_at IS NULL OR t.trial_ends_at <= now()))::bigint AS mrr,

         count(*) FILTER (WHERE si.status = 'open')::int AS open_count,
         coalesce(sum(si.amount) FILTER (WHERE si.status = 'open'), 0)::bigint AS open_total,
         count(*) FILTER (WHERE si.status = 'open' AND si.due_date < current_date)::int
           AS overdue_count,
         coalesce(sum(si.amount) FILTER (
           WHERE si.status = 'open' AND si.due_date < current_date), 0)::bigint AS overdue_total,
         coalesce(sum(si.paid_amount) FILTER (
           WHERE si.status = 'paid'
             AND si.paid_at >= date_trunc('month', now())), 0)::bigint AS paid_this_month,
         coalesce(sum(si.amount) FILTER (
           WHERE si.issued_at >= date_trunc('month', now())
             AND si.status <> 'void'), 0)::bigint AS invoiced_this_month,

         (SELECT count(*)
            FROM tenants t
           WHERE t.status = 'active' AND t.deleted_at IS NULL AND t.plan_id IS NOT NULL
             AND (t.trial_ends_at IS NULL OR t.trial_ends_at <= now())
             AND NOT EXISTS (
               SELECT 1 FROM subscription_invoices x
                WHERE x.tenant_id = t.id
                  AND x.period_start = date_trunc('month', current_date)::date))::int
           AS unbilled_clinics
       FROM subscription_invoices si`,
    );
    const r = rows[0]!;
    return {
      mrr: Number(r.mrr),
      openCount: r.open_count,
      openTotal: Number(r.open_total),
      overdueCount: r.overdue_count,
      overdueTotal: Number(r.overdue_total),
      paidThisMonth: Number(r.paid_this_month),
      invoicedThisMonth: Number(r.invoiced_this_month),
      unbilledClinics: r.unbilled_clinics,
    };
  }

  async list(filter: { status?: string; tenantId?: string; overdue?: boolean } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      params.push(filter.status);
      where.push(`si.status = $${params.length}`);
    }
    if (filter.tenantId) {
      params.push(filter.tenantId);
      where.push(`si.tenant_id = $${params.length}`);
    }
    if (filter.overdue) where.push(`si.status = 'open' AND si.due_date < current_date`);

    const { rows } = await this.db.adminQuery<InvoiceRow>(
      `SELECT ${INVOICE_COLUMNS}
         FROM subscription_invoices si
         JOIN tenants t ON t.id = si.tenant_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY si.due_date DESC, t.name
        LIMIT 500`,
      params,
    );
    const today = await this.today();
    return rows.map((r) => mapInvoice(r, today));
  }

  async forTenant(tenantId: string) {
    return this.list({ tenantId });
  }

  /**
   * Issue the month's invoices.
   *
   * Idempotent by constraint, not by check-then-insert: ON CONFLICT DO NOTHING
   * against `si_one_per_period`. Two admins pressing the button at once is
   * therefore safe, and so is pressing it twice.
   *
   * Who is billed: active, undeleted, on a plan, and past any trial. A clinic
   * still in trial has agreed to nothing yet.
   */
  async run(dto: RunBillingDto, actor: PlatformAuditActor) {
    const period = dto.period ?? null;

    return this.db.withAdminTransaction(async (client) => {
      const { rows: due } = await client.query<{
        tenant_id: string;
        plan_id: string;
        plan_code: string;
        plan_name: string;
        price_monthly: number;
        period_start: string;
        period_end: string;
      }>(
        `SELECT t.id AS tenant_id, p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
                p.price_monthly,
                to_char(date_trunc('month', $1::date), 'YYYY-MM-DD') AS period_start,
                to_char(date_trunc('month', $1::date) + interval '1 month', 'YYYY-MM-DD')
                  AS period_end
           FROM tenants t
           JOIN plans p ON p.id = t.plan_id
          WHERE t.status = 'active' AND t.deleted_at IS NULL
            AND (t.trial_ends_at IS NULL OR t.trial_ends_at <= now())`,
        [period ?? new Date().toISOString().slice(0, 10)],
      );

      const issued: string[] = [];
      for (const d of due) {
        // The number is allocated per insert so a skipped conflict does not
        // burn one, which would leave visible gaps in the vendor's sequence.
        const { rows } = await client.query<{ id: string; number: string }>(
          `INSERT INTO subscription_invoices
             (tenant_id, number, period_start, period_end, plan_id, plan_code, plan_name,
              amount, due_date, created_by)
           VALUES ($1,
                   'SUB-' || to_char($2::date, 'YYYYMM') || '-' ||
                     lpad((
                       SELECT count(*) + 1 FROM subscription_invoices s
                        WHERE s.period_start = $2::date
                     )::text, 4, '0'),
                   $2, $3, $4, $5, $6, $7,
                   $2::date + $8::int, $9)
           ON CONFLICT ON CONSTRAINT si_one_per_period DO NOTHING
           RETURNING id, number`,
          [
            d.tenant_id,
            d.period_start,
            d.period_end,
            d.plan_id,
            d.plan_code,
            d.plan_name,
            d.price_monthly,
            PAYMENT_TERMS_DAYS,
            actor.id,
          ],
        );
        if (rows[0]) issued.push(rows[0].number);
      }

      await this.audit.record(client, actor, {
        action: 'platform.billing.run',
        entityType: 'subscription_billing',
        metadata: {
          period,
          considered: due.length,
          issued: issued.length,
          numbers: issued,
        },
      });

      return { considered: due.length, issued: issued.length, numbers: issued };
    });
  }

  /** Record what arrived against one invoice. */
  async markPaid(id: string, dto: MarkPaidDto, actor: PlatformAuditActor) {
    return this.db.withAdminTransaction(async (client) => {
      const { rows: found } = await client.query<{ status: string; amount: number }>(
        `SELECT status, amount FROM subscription_invoices WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const invoice = found[0];
      if (!invoice) throw new NotFoundException('No such subscription invoice.');
      if (invoice.status === 'paid') {
        throw new BadRequestException({
          code: 'already_paid',
          message: 'This invoice is already settled.',
        });
      }
      if (invoice.status === 'void') {
        throw new BadRequestException({
          code: 'invoice_void',
          message: 'A voided invoice cannot be paid.',
        });
      }

      const amount = dto.amount ?? invoice.amount;
      const { rows } = await client.query<InvoiceRow>(
        `UPDATE subscription_invoices
            SET status = 'paid', paid_at = coalesce($2::timestamptz, now()),
                paid_amount = $3, method = $4, reference = $5,
                note = coalesce($6, note), updated_at = now()
          WHERE id = $1
          RETURNING id`,
        [
          id,
          dto.paidAt ?? null,
          amount,
          dto.method,
          dto.reference ?? null,
          dto.note ?? null,
        ],
      );

      await this.audit.record(client, actor, {
        action: 'platform.billing.paid',
        entityType: 'subscription_invoice',
        entityId: id,
        metadata: { amount, method: dto.method, reference: dto.reference ?? null },
      });

      return { id: rows[0]!.id, status: 'paid' as const, paidAmount: amount };
    });
  }

  /**
   * Void an invoice that should never have been issued.
   *
   * Voiding rather than deleting: the vendor's invoice numbers are a sequence
   * someone may have to account for, and a missing number is a question no
   * answer fits.
   */
  async void(id: string, dto: VoidInvoiceDto, actor: PlatformAuditActor) {
    return this.db.withAdminTransaction(async (client) => {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM subscription_invoices WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const invoice = rows[0];
      if (!invoice) throw new NotFoundException('No such subscription invoice.');
      if (invoice.status === 'paid') {
        throw new BadRequestException({
          code: 'already_paid',
          message:
            'A settled invoice cannot be voided. Refund it outside the system first.',
        });
      }

      await client.query(
        `UPDATE subscription_invoices
            SET status = 'void', note = $2, updated_at = now()
          WHERE id = $1`,
        [id, dto.reason],
      );
      await this.audit.record(client, actor, {
        action: 'platform.billing.void',
        entityType: 'subscription_invoice',
        entityId: id,
        metadata: { reason: dto.reason },
      });
      return { id, status: 'void' as const };
    });
  }
}
