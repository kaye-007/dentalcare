import { BadRequestException, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';

/**
 * M9 — owner-only analytics. Everything is computed inside the tenant
 * transaction (RLS-scoped). Range is inclusive, date-based (YYYY-MM-DD).
 *
 * Money is minor units (0006). Sums are cast to bigint, never int: a year of
 * a busy clinic's takings in cents passes 2^31, and an ::int cast would turn
 * that into an error on the report page. node-postgres returns bigint as a
 * string, which is why every figure below goes through Number().
 *
 * Notes on attribution:
 *  - Revenue by treatment comes from invoice line items (issued, not cancelled).
 *  - Dentist breakdown is appointment-based (appointments carry the practitioner;
 *    invoices deliberately don't in the MVP).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - 5, 1);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(from), to: iso(to) };
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /**
   * TVSH for a period, as the accountant needs it: what was charged at each
   * rate, and how much of it went to the tax authority.
   *
   * Grouped by the rate stored on the line, not by today's clinic rate — a
   * line billed at 20 % stays in the 20 % band after the clinic's rate
   * changes. Cancelled invoices are left out; an invoice whose registration
   * was refused is not, because it was still issued.
   *
   * The fiscal/internal split is the number an accountant asks for first:
   * takings the authority has seen, and takings it has not (0015).
   */
  async vat(fromRaw?: string, toRaw?: string) {
    const def = defaultRange();
    const from = fromRaw && DATE_RE.test(fromRaw) ? fromRaw : def.from;
    const to = toRaw && DATE_RE.test(toRaw) ? toRaw : def.to;
    if (from > to) throw new BadRequestException('"from" must be before "to"');

    return this.tx(async (client) => {
      const { rows: bands } = await client.query<{
        tax_rate_bp: number;
        net: string;
        vat: string;
        gross: string;
        invoices: string;
      }>(
        `SELECT li.tax_rate_bp,
                sum(li.amount - li.tax_amount)::bigint AS net,
                sum(li.tax_amount)::bigint            AS vat,
                sum(li.amount)::bigint                AS gross,
                count(DISTINCT li.invoice_id)::bigint AS invoices
           FROM invoice_line_items li
           JOIN invoices i ON i.id = li.invoice_id
          WHERE i.status <> 'cancelled' AND i.issued_at BETWEEN $1::date AND $2::date
          GROUP BY li.tax_rate_bp
          ORDER BY li.tax_rate_bp`,
        [from, to],
      );

      const { rows: split } = await client.query<{
        document_kind: string;
        registered: boolean;
        net: string;
        vat: string;
        gross: string;
        invoices: string;
      }>(
        `SELECT i.document_kind,
                EXISTS (SELECT 1 FROM fiscal_invoices f
                         WHERE f.invoice_id = i.id AND f.status = 'fiscalized') AS registered,
                sum(i.total - i.tax_amount)::bigint AS net,
                sum(i.tax_amount)::bigint           AS vat,
                sum(i.total)::bigint                AS gross,
                count(*)::bigint                    AS invoices
           FROM invoices i
          WHERE i.status <> 'cancelled' AND i.issued_at BETWEEN $1::date AND $2::date
          GROUP BY i.document_kind, registered`,
        [from, to],
      );

      const band = (r: (typeof bands)[number]) => ({
        rateBp: r.tax_rate_bp,
        net: Number(r.net),
        vat: Number(r.vat),
        gross: Number(r.gross),
        invoices: Number(r.invoices),
      });
      const totals = bands.reduce(
        (acc, r) => ({
          net: acc.net + Number(r.net),
          vat: acc.vat + Number(r.vat),
          gross: acc.gross + Number(r.gross),
        }),
        { net: 0, vat: 0, gross: 0 },
      );

      return {
        from,
        to,
        bands: bands.map(band),
        totals,
        documents: split.map((r) => ({
          documentKind: r.document_kind as 'internal' | 'fiscal',
          registered: r.registered,
          net: Number(r.net),
          vat: Number(r.vat),
          gross: Number(r.gross),
          invoices: Number(r.invoices),
        })),
      };
    });
  }

  async overview(fromRaw?: string, toRaw?: string) {
    const def = defaultRange();
    const from = fromRaw && DATE_RE.test(fromRaw) ? fromRaw : def.from;
    const to = toRaw && DATE_RE.test(toRaw) ? toRaw : def.to;
    if (from > to) throw new BadRequestException('"from" must be before "to"');

    return this.tx(async (client) => {
      const num = (r: { rows: { s?: string | null }[] }) => Number(r.rows[0]?.s ?? 0);

      // Sequential, not Promise.all: these all share one PoolClient, and a
      // node-postgres client executes queries serially anyway. Issuing them
      // concurrently on the same client is deprecated and removed in pg@9,
      // so this is the same work without the warning.
      const invoiced = await client.query(
        `SELECT coalesce(sum(total),0) AS s FROM invoices
          WHERE status <> 'cancelled' AND issued_at BETWEEN $1 AND $2`,
        [from, to],
      );
      const collected = await client.query(
        `SELECT coalesce(sum(amount),0) AS s FROM payments
          WHERE voided_at IS NULL AND paid_at::date BETWEEN $1 AND $2`,
        [from, to],
      );
      const expenses = await client.query(
        `SELECT coalesce(sum(amount),0) AS s FROM expenses
          WHERE voided_at IS NULL AND expense_date BETWEEN $1 AND $2`,
        [from, to],
      );
      const outstanding = await client.query(
        `SELECT coalesce(sum(i.total - coalesce(p.paid,0)),0) AS s
           FROM invoices i
           LEFT JOIN LATERAL (
             SELECT sum(amount) AS paid FROM payments
              WHERE invoice_id = i.id AND voided_at IS NULL
           ) p ON true
          WHERE i.status IN ('unpaid','partially_paid')`,
      );
      const newPatients = await client.query(
        `SELECT count(*)::int AS s FROM patients
          WHERE created_at::date BETWEEN $1 AND $2`,
        [from, to],
      );
      const appts = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'completed')::int AS completed
           FROM appointments WHERE starts_at::date BETWEEN $1 AND $2`,
        [from, to],
      );

      const trend = await client.query(
        `WITH months AS (
           SELECT generate_series(
             date_trunc('month', $1::date),
             date_trunc('month', $2::date),
             interval '1 month'
           ) AS m
         )
         SELECT to_char(m, 'YYYY-MM') AS month,
                coalesce((SELECT sum(amount) FROM payments
                           WHERE voided_at IS NULL
                             AND date_trunc('month', paid_at) = m
                             AND paid_at::date BETWEEN $1 AND $2), 0)::bigint AS collected,
                coalesce((SELECT sum(amount) FROM expenses
                           WHERE voided_at IS NULL
                             AND date_trunc('month', expense_date) = m
                             AND expense_date BETWEEN $1 AND $2), 0)::bigint AS expenses
           FROM months ORDER BY m`,
        [from, to],
      );

      const byTreatment = await client.query(
        `SELECT coalesce(t.name, 'Custom items') AS label, sum(li.amount)::bigint AS value
           FROM invoice_line_items li
           JOIN invoices i ON i.id = li.invoice_id
           LEFT JOIN treatments t ON t.id = li.treatment_id
          WHERE i.status <> 'cancelled' AND i.issued_at BETWEEN $1 AND $2
          GROUP BY coalesce(t.name, 'Custom items')
          ORDER BY value DESC LIMIT 10`,
        [from, to],
      );

      const byCategory = await client.query(
        `SELECT category AS label, sum(amount)::bigint AS value
           FROM expenses
          WHERE voided_at IS NULL AND expense_date BETWEEN $1 AND $2
          GROUP BY category ORDER BY value DESC`,
        [from, to],
      );

      const byMethod = await client.query(
        `SELECT method AS label, sum(amount)::bigint AS value
           FROM payments
          WHERE voided_at IS NULL AND paid_at::date BETWEEN $1 AND $2
          GROUP BY method ORDER BY value DESC`,
        [from, to],
      );

      const byDentist = await client.query(
        `SELECT coalesce(u.full_name, 'Unassigned') AS label,
                count(*)::int AS total,
                count(*) FILTER (WHERE a.status = 'completed')::int AS completed
           FROM appointments a
           LEFT JOIN users u ON u.id = a.staff_id
          WHERE a.starts_at::date BETWEEN $1 AND $2
          GROUP BY coalesce(u.full_name, 'Unassigned')
          ORDER BY total DESC LIMIT 10`,
        [from, to],
      );

      const totalCollected = num(collected);
      const totalExpenses = num(expenses);

      return {
        range: { from, to },
        totals: {
          invoiced: num(invoiced),
          collected: totalCollected,
          expenses: totalExpenses,
          profit: totalCollected - totalExpenses,
          outstanding: num(outstanding),
          newPatients: Number(newPatients.rows[0]?.s ?? 0),
          appointments: Number(appts.rows[0]?.total ?? 0),
          appointmentsCompleted: Number(appts.rows[0]?.completed ?? 0),
        },
        monthlyTrend: trend.rows.map((r) => ({
          month: r.month as string,
          collected: Number(r.collected),
          expenses: Number(r.expenses),
          profit: Number(r.collected) - Number(r.expenses),
        })),
        revenueByTreatment: byTreatment.rows.map((r) => ({ label: r.label, value: Number(r.value) })),
        expensesByCategory: byCategory.rows.map((r) => ({ label: r.label, value: Number(r.value) })),
        paymentsByMethod: byMethod.rows.map((r) => ({ label: r.label, value: Number(r.value) })),
        appointmentsByDentist: byDentist.rows.map((r) => ({
          label: r.label,
          total: Number(r.total),
          completed: Number(r.completed),
        })),
      };
    });
  }
}
