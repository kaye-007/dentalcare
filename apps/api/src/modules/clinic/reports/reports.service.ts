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
 *
 * Days are the clinic's days. A payment taken at 00:30 in Tirana belongs to
 * that day, not to the day before because the server's clock is UTC — and the
 * default period ends on the clinic's today, not the server's.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The clinic's zone, for turning instants into its calendar days. */
const TZ = `coalesce((SELECT timezone FROM clinic_settings LIMIT 1), 'Europe/Tirane')`;
/** An instant column as the clinic's calendar date. */
const day = (col: string) => `(${col} AT TIME ZONE ${TZ})::date`;

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
   * The period asked for, or by default the last six months up to the
   * clinic's today.
   */
  private async range(client: PoolClient, fromRaw?: string, toRaw?: string) {
    const { rows } = await client.query<{ today: string; start: string }>(
      `SELECT ${day('now()')}::text AS today,
              (date_trunc('month', ${day('now()')}) - interval '5 months')::date::text AS start`,
    );
    const from = fromRaw && DATE_RE.test(fromRaw) ? fromRaw : rows[0]!.start;
    const to = toRaw && DATE_RE.test(toRaw) ? toRaw : rows[0]!.today;
    if (from > to) throw new BadRequestException('"from" must be before "to"');
    return { from, to };
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
    return this.tx(async (client) => {
      const { from, to } = await this.range(client, fromRaw, toRaw);
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
    return this.tx(async (client) => {
      const { from, to } = await this.range(client, fromRaw, toRaw);
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
          WHERE voided_at IS NULL AND ${day('paid_at')} BETWEEN $1 AND $2`,
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
          WHERE ${day('created_at')} BETWEEN $1 AND $2`,
        [from, to],
      );
      const appts = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                count(*) FILTER (WHERE status = 'no_show')::int AS no_shows
           FROM appointments WHERE ${day('starts_at')} BETWEEN $1 AND $2`,
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
                             AND date_trunc('month', ${day('paid_at')}) = m
                             AND ${day('paid_at')} BETWEEN $1 AND $2), 0)::bigint AS collected,
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
          WHERE voided_at IS NULL AND ${day('paid_at')} BETWEEN $1 AND $2
          GROUP BY method ORDER BY value DESC`,
        [from, to],
      );

      const byDentist = await client.query(
        `SELECT coalesce(u.full_name, 'Unassigned') AS label,
                count(*)::int AS total,
                count(*) FILTER (WHERE a.status = 'completed')::int AS completed
           FROM appointments a
           LEFT JOIN users u ON u.id = a.staff_id
          WHERE ${day('a.starts_at')} BETWEEN $1 AND $2
          GROUP BY coalesce(u.full_name, 'Unassigned')
          ORDER BY total DESC LIMIT 10`,
        [from, to],
      );

      // What was done in the chair: completed treatment, by service, counted.
      const performed = await client.query(
        `SELECT coalesce(t.name, p.description) AS label, count(*)::int AS value
           FROM clinical_procedures p
           LEFT JOIN treatments t ON t.id = p.treatment_id
          WHERE p.status = 'completed' AND p.entered_in_error_at IS NULL
            AND p.performed_on BETWEEN $1 AND $2
          GROUP BY coalesce(t.name, p.description)
          ORDER BY value DESC LIMIT 10`,
        [from, to],
      );

      // What the treatment used up: stock recorded as used, by item.
      const consumed = await client.query(
        `SELECT i.name AS label, i.unit, sum(-m.quantity_delta)::numeric(12,2)::text AS value
           FROM stock_movements m
           JOIN inventory_items i ON i.id = m.item_id
          WHERE m.kind = 'usage' AND ${day('m.created_at')} BETWEEN $1 AND $2
          GROUP BY i.name, i.unit
          ORDER BY sum(-m.quantity_delta) DESC LIMIT 10`,
        [from, to],
      );

      // Lab work (0020): ordered and fitted in the period, what is open now,
      // and what the fitted work cost.
      const lab = await client.query<{
        ordered: number;
        fitted: number;
        open: number;
        late: number;
        cost: string;
      }>(
        `SELECT count(*) FILTER (WHERE ${day('created_at')} BETWEEN $1 AND $2)::int AS ordered,
                count(*) FILTER (WHERE status = 'fitted'
                                   AND ${day('fitted_at')} BETWEEN $1 AND $2)::int AS fitted,
                count(*) FILTER (WHERE status IN ('preparing', 'sent', 'received'))::int AS open,
                count(*) FILTER (WHERE status IN ('preparing', 'sent')
                                   AND due_on < ${day('now()')})::int AS late,
                coalesce(sum(cost) FILTER (WHERE status = 'fitted'
                                   AND ${day('fitted_at')} BETWEEN $1 AND $2), 0)::bigint::text AS cost
           FROM lab_orders`,
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
          appointmentsCancelled: Number(appts.rows[0]?.cancelled ?? 0),
          appointmentsNoShow: Number(appts.rows[0]?.no_shows ?? 0),
        },
        treatmentsPerformed: performed.rows.map((r) => ({
          label: r.label as string,
          value: Number(r.value),
        })),
        consumption: consumed.rows.map((r) => ({
          label: r.label as string,
          unit: r.unit as string,
          value: Number(r.value),
        })),
        lab: {
          ordered: lab.rows[0]!.ordered,
          fitted: lab.rows[0]!.fitted,
          open: lab.rows[0]!.open,
          late: lab.rows[0]!.late,
          cost: Number(lab.rows[0]!.cost),
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
