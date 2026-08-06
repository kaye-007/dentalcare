import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Module,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OwnerGuard } from '../auth/owner.guard';
import { AuthModule } from '../auth/auth.module';

/**
 * M9 — owner-only analytics. Everything is computed inside the tenant
 * transaction (RLS-scoped). Range is inclusive, date-based (YYYY-MM-DD).
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
          WHERE paid_at::date BETWEEN $1 AND $2`,
        [from, to],
      );
      const expenses = await client.query(
        `SELECT coalesce(sum(amount),0) AS s FROM expenses
          WHERE expense_date BETWEEN $1 AND $2`,
        [from, to],
      );
      const outstanding = await client.query(
        `SELECT coalesce(sum(i.total - coalesce(p.paid,0)),0) AS s
           FROM invoices i
           LEFT JOIN LATERAL (
             SELECT sum(amount) AS paid FROM payments WHERE invoice_id = i.id
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
                           WHERE date_trunc('month', paid_at) = m
                             AND paid_at::date BETWEEN $1 AND $2), 0)::int AS collected,
                coalesce((SELECT sum(amount) FROM expenses
                           WHERE date_trunc('month', expense_date) = m
                             AND expense_date BETWEEN $1 AND $2), 0)::int AS expenses
           FROM months ORDER BY m`,
        [from, to],
      );

      const byTreatment = await client.query(
        `SELECT coalesce(t.name, 'Custom items') AS label, sum(li.amount)::int AS value
           FROM invoice_line_items li
           JOIN invoices i ON i.id = li.invoice_id
           LEFT JOIN treatments t ON t.id = li.treatment_id
          WHERE i.status <> 'cancelled' AND i.issued_at BETWEEN $1 AND $2
          GROUP BY coalesce(t.name, 'Custom items')
          ORDER BY value DESC LIMIT 10`,
        [from, to],
      );

      const byCategory = await client.query(
        `SELECT category AS label, sum(amount)::int AS value
           FROM expenses WHERE expense_date BETWEEN $1 AND $2
          GROUP BY category ORDER BY value DESC`,
        [from, to],
      );

      const byMethod = await client.query(
        `SELECT method AS label, sum(amount)::int AS value
           FROM payments WHERE paid_at::date BETWEEN $1 AND $2
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

@Controller('reports')
@UseGuards(JwtAuthGuard, OwnerGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('overview')
  overview(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.overview(from, to);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [ReportsController],
  providers: [ReportsService, OwnerGuard],
})
export class ReportsModule {}
