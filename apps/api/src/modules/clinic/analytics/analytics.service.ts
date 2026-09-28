import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { collectionRate } from '@/modules/clinic/finance';

/**
 * Financial analytics: revenue over time, collection performance, and
 * production broken down by who did the work, where, and what kind.
 *
 * EVERY endpoint here requires `reports:read`, which belongs to the doctor
 * alone. Reception bills, collects and records expenses all day and needs
 * none of this: the day-to-day is `invoices:read`, while revenue set against
 * expenses is a different question and a different permission. Enforced by
 * the guard, not by hiding a menu item.
 *
 * Aggregation happens in SQL. Pulling rows into Node to sum them would move
 * megabytes for a number, and would silently break the moment a clinic has a
 * year of history.
 */

/**
 * Clamp a requested window so one query cannot scan an unbounded range. The
 * default window ends on the clinic's today (0023), not the server's.
 */
async function resolveRange(client: PoolClient, fromRaw?: string, toRaw?: string) {
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const to = isDate(toRaw)
    ? toRaw!
    : (await client.query<{ d: string }>('SELECT clinic_today()::text AS d')).rows[0]!.d;
  if (isDate(fromRaw)) return { from: fromRaw!, to };
  // Default window: the twelve months ending today.
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return { from: d.toISOString().slice(0, 10), to };
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /**
   * Revenue over time.
   *
   * BILLED and COLLECTED are deliberately separate series. Billed is what was
   * invoiced on a date; collected is what actually arrived. A clinic that
   * reads only one of them either celebrates money it has not received or
   * misses that it is invoicing far more than it collects.
   */
  async revenue(granularity: 'day' | 'month', fromRaw?: string, toRaw?: string) {
    const bucket = granularity === 'day' ? 'day' : 'month';

    return this.tx(async (client) => {
      const { from, to } = await resolveRange(client, fromRaw, toRaw);
      const { rows } = await client.query<{
        period: string;
        billed: string;
        collected: string;
        invoice_count: string;
        payment_count: string;
      }>(
        `WITH periods AS (
           SELECT generate_series($1::date, $2::date, ('1 ' || $3)::interval)::date AS period
         ),
         billed AS (
           SELECT date_trunc($3, issued_at)::date AS period,
                  sum(total) AS amount, count(*) AS n
             FROM invoices
            WHERE status <> 'cancelled'
              AND issued_at BETWEEN $1::date AND $2::date
            GROUP BY 1
         ),
         collected AS (
           SELECT date_trunc($3, paid_at AT TIME ZONE clinic_zone())::date AS period,
                  sum(amount) AS amount, count(*) AS n
             FROM payments
            WHERE voided_at IS NULL
              AND (paid_at AT TIME ZONE clinic_zone())::date BETWEEN $1::date AND $2::date
            GROUP BY 1
         )
         SELECT date_trunc($3, p.period)::date::text AS period,
                coalesce(b.amount, 0)::text AS billed,
                coalesce(c.amount, 0)::text AS collected,
                coalesce(b.n, 0)::text AS invoice_count,
                coalesce(c.n, 0)::text AS payment_count
           FROM periods p
           LEFT JOIN billed b ON b.period = date_trunc($3, p.period)::date
           LEFT JOIN collected c ON c.period = date_trunc($3, p.period)::date
          GROUP BY 1, 2, 3, 4, 5
          ORDER BY 1`,
        [from, to, bucket],
      );

      const series = rows.map((r) => ({
        period: r.period,
        billed: Number(r.billed),
        collected: Number(r.collected),
        invoiceCount: Number(r.invoice_count),
        paymentCount: Number(r.payment_count),
      }));

      const billed = series.reduce((s, r) => s + r.billed, 0);
      const collected = series.reduce((s, r) => s + r.collected, 0);

      return {
        from,
        to,
        granularity,
        series,
        totals: {
          billed,
          collected,
          collectionRate: collectionRate(billed, collected),
          invoiceCount: series.reduce((s, r) => s + r.invoiceCount, 0),
          paymentCount: series.reduce((s, r) => s + r.paymentCount, 0),
        },
      };
    });
  }

  /**
   * Production by clinician.
   *
   * Measured from `clinical_procedures`, not from invoices: an invoice has no
   * clinician, and attributing a whole bill to the plan's dentist would credit
   * one person for work several people did. The procedure log records who
   * actually performed each item, which is the honest basis for this number.
   */
  async byDentist(fromRaw?: string, toRaw?: string) {
    return this.tx(async (client) => {
      const { from, to } = await resolveRange(client, fromRaw, toRaw);
      const { rows } = await client.query<{
        clinician_id: string | null;
        clinician_name: string | null;
        production: string;
        procedure_count: string;
        patient_count: string;
      }>(
        `SELECT cp.clinician_id,
                coalesce(u.full_name, 'Unattributed') AS clinician_name,
                coalesce(sum(cp.fee), 0)::text AS production,
                count(*)::text AS procedure_count,
                count(DISTINCT cp.patient_id)::text AS patient_count
           FROM clinical_procedures cp
           LEFT JOIN users u ON u.id = cp.clinician_id
          WHERE cp.status = 'completed'
            AND cp.entered_in_error_at IS NULL
            AND cp.performed_on BETWEEN $1::date AND $2::date
          GROUP BY cp.clinician_id, u.full_name
          ORDER BY sum(cp.fee) DESC NULLS LAST`,
        [from, to],
      );
      return {
        from,
        to,
        rows: rows.map((r) => ({
          clinicianId: r.clinician_id,
          clinicianName: r.clinician_name,
          production: Number(r.production),
          procedureCount: Number(r.procedure_count),
          patientCount: Number(r.patient_count),
        })),
      };
    });
  }

  /**
   * Production and utilisation by treatment room.
   *
   * The room comes from the appointment a procedure was performed at, which is
   * the only place the system knows where treatment happened. Procedures
   * logged without an appointment are grouped as unassigned rather than
   * silently dropped — a room report that quietly omits work is worse than one
   * that admits the gap.
   */
  async byOperatory(fromRaw?: string, toRaw?: string) {
    return this.tx(async (client) => {
      const { from, to } = await resolveRange(client, fromRaw, toRaw);
      const { rows } = await client.query<{
        operatory_id: string | null;
        operatory_name: string | null;
        production: string;
        procedure_count: string;
        appointment_count: string;
        booked_minutes: string;
      }>(
        `WITH proc AS (
           SELECT a.operatory_id,
                  sum(cp.fee) AS production,
                  count(*) AS procedure_count
             FROM clinical_procedures cp
             LEFT JOIN appointments a ON a.id = cp.appointment_id
            WHERE cp.status = 'completed'
              AND cp.entered_in_error_at IS NULL
              AND cp.performed_on BETWEEN $1::date AND $2::date
            GROUP BY a.operatory_id
         ),
         appts AS (
           SELECT operatory_id,
                  count(*) AS appointment_count,
                  sum(EXTRACT(EPOCH FROM (ends_at - starts_at)) / 60)::bigint AS booked_minutes
             FROM appointments
            WHERE status IN ('completed','checked_in','in_progress')
              AND (starts_at AT TIME ZONE clinic_zone())::date BETWEEN $1::date AND $2::date
            GROUP BY operatory_id
         )
         SELECT o.id AS operatory_id,
                coalesce(o.name, 'No room assigned') AS operatory_name,
                coalesce(proc.production, 0)::text AS production,
                coalesce(proc.procedure_count, 0)::text AS procedure_count,
                coalesce(appts.appointment_count, 0)::text AS appointment_count,
                coalesce(appts.booked_minutes, 0)::text AS booked_minutes
           FROM operatories o
           FULL OUTER JOIN proc ON proc.operatory_id = o.id
           FULL OUTER JOIN appts ON appts.operatory_id = o.id
          ORDER BY coalesce(proc.production, 0) DESC, o.name`,
        [from, to],
      );
      return {
        from,
        to,
        rows: rows.map((r) => ({
          operatoryId: r.operatory_id,
          operatoryName: r.operatory_name,
          production: Number(r.production),
          procedureCount: Number(r.procedure_count),
          appointmentCount: Number(r.appointment_count),
          bookedMinutes: Number(r.booked_minutes),
          bookedHours: Math.round(Number(r.booked_minutes) / 6) / 10,
        })),
      };
    });
  }

  /**
   * Which kinds of work earn the money. Grouped by the treatment catalogue
   * entry where there is one, falling back to the procedure code, then to the
   * free-text description.
   */
  async byProcedure(fromRaw?: string, toRaw?: string) {
    return this.tx(async (client) => {
      const { from, to } = await resolveRange(client, fromRaw, toRaw);
      const { rows } = await client.query<{
        label: string;
        code: string | null;
        production: string;
        procedure_count: string;
        average_fee: string;
      }>(
        `SELECT coalesce(t.name, pc.description, cp.description) AS label,
                pc.code,
                coalesce(sum(cp.fee), 0)::text AS production,
                count(*)::text AS procedure_count,
                round(avg(cp.fee))::text AS average_fee
           FROM clinical_procedures cp
           LEFT JOIN treatments t ON t.id = cp.treatment_id
           LEFT JOIN procedure_codes pc ON pc.id = cp.procedure_code_id
          WHERE cp.status = 'completed'
            AND cp.entered_in_error_at IS NULL
            AND cp.performed_on BETWEEN $1::date AND $2::date
          GROUP BY coalesce(t.name, pc.description, cp.description), pc.code
          ORDER BY sum(cp.fee) DESC NULLS LAST
          LIMIT 50`,
        [from, to],
      );
      return {
        from,
        to,
        rows: rows.map((r) => ({
          label: r.label,
          code: r.code,
          production: Number(r.production),
          procedureCount: Number(r.procedure_count),
          averageFee: Number(r.average_fee),
        })),
      };
    });
  }

  /** Everything the dashboard needs for its headline figures, in one call. */
  async dashboard(fromRaw?: string, toRaw?: string) {
    return this.tx(async (client) => {
      const { from, to } = await resolveRange(client, fromRaw, toRaw);
      const { rows } = await client.query<{
        billed: string;
        collected: string;
        outstanding: string;
        expenses: string;
        invoice_count: string;
        unpaid_count: string;
        patients_seen: string;
        procedures_done: string;
      }>(
        `SELECT
           (SELECT coalesce(sum(total),0) FROM invoices
             WHERE status <> 'cancelled' AND issued_at BETWEEN $1::date AND $2::date)::text AS billed,
           (SELECT coalesce(sum(amount),0) FROM payments
             WHERE voided_at IS NULL
               AND (paid_at AT TIME ZONE clinic_zone())::date BETWEEN $1::date AND $2::date)::text AS collected,
           (SELECT coalesce(sum(i.total - coalesce(
                     (SELECT sum(amount) FROM payments
                       WHERE invoice_id = i.id AND voided_at IS NULL), 0)), 0)
              FROM invoices i WHERE i.status IN ('unpaid','partially_paid'))::text AS outstanding,
           (SELECT coalesce(sum(amount),0) FROM expenses
             WHERE voided_at IS NULL
               AND expense_date BETWEEN $1::date AND $2::date)::text AS expenses,
           (SELECT count(*) FROM invoices
             WHERE status <> 'cancelled' AND issued_at BETWEEN $1::date AND $2::date)::text AS invoice_count,
           (SELECT count(*) FROM invoices
             WHERE status IN ('unpaid','partially_paid'))::text AS unpaid_count,
           (SELECT count(DISTINCT patient_id) FROM appointments
             WHERE status = 'completed'
               AND (starts_at AT TIME ZONE clinic_zone())::date BETWEEN $1::date AND $2::date)::text AS patients_seen,
           (SELECT count(*) FROM clinical_procedures
             WHERE status = 'completed'
               AND entered_in_error_at IS NULL
               AND performed_on BETWEEN $1::date AND $2::date)::text AS procedures_done`,
        [from, to],
      );
      const r = rows[0]!;
      const billed = Number(r.billed);
      const collected = Number(r.collected);
      const expenses = Number(r.expenses);

      return {
        from,
        to,
        billed,
        collected,
        expenses,
        // Profit is measured on money RECEIVED, not money invoiced. An
        // unpaid invoice is not income, and reporting it as profit is how a
        // clinic ends up believing it can afford something it cannot.
        netCollected: collected - expenses,
        outstanding: Number(r.outstanding),
        collectionRate: collectionRate(billed, collected),
        invoiceCount: Number(r.invoice_count),
        unpaidInvoiceCount: Number(r.unpaid_count),
        patientsSeen: Number(r.patients_seen),
        proceduresDone: Number(r.procedures_done),
      };
    });
  }
}
