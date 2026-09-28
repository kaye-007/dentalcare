import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { RequestContextService } from '@/core/request-context/request-context';
import {
  AGEING_BUCKETS,
  LEDGER_SIGN,
  type AgeingBucketKey,
  type LedgerEntryType,
  bucketFor,
  calculateInvoice,
  calculateInvoiceLine,
  planLinesToInvoiceLines,
} from '@/modules/clinic/finance';
import { ClinicAuditService, ClinicAuditActor } from '@/core/audit/clinic-audit.service';
import { moneyText } from '@/core/money/clinic-currency';
import { nextInvoiceNumber } from '@/core/money/invoice-number';
import { GenerateInvoiceDto, LedgerAdjustmentDto } from './dto/billing.dto';

/**
 * Plan-driven invoicing, the patient ledger, and accounts receivable.
 *
 * Kept beside the existing finance module rather than folded into it: that
 * module handles ad-hoc invoices and payments and is already covered by
 * tests. What is new here is the path from CLINICAL work to a bill — which is
 * the whole point of having built Phases 3 and 4.
 */

const MAX_SEQ_ATTEMPTS = 5;

const UNIQUE_VIOLATION = '23505';

/* ═════════════════════════ service ═════════════════════════ */

interface ClinicBilling {
  currency: string;
  vatRateBp: number;
  paymentTermsDays: number;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
    private readonly request: RequestContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /**
   * Billing configuration for this clinic. A clinic with no settings row is
   * treated as EUR, no VAT, payable on issue — the same defaults the schema
   * carries, so behaviour does not depend on whether the row exists.
   */
  private async billingConfig(client: PoolClient): Promise<ClinicBilling> {
    const { rows } = await client.query<{
      currency: string;
      vat_rate_bp: number;
      payment_terms_days: number;
    }>('SELECT currency, vat_rate_bp, payment_terms_days FROM clinic_settings LIMIT 1');
    return {
      currency: rows[0]?.currency ?? 'EUR',
      vatRateBp: rows[0]?.vat_rate_bp ?? 0,
      paymentTermsDays: rows[0]?.payment_terms_days ?? 0,
    };
  }

  /* ── invoice generation from a treatment plan ── */

  /**
   * Turn a treatment plan into an invoice.
   *
   * Four things make this safe to run twice:
   *  - only lines that are not already billed are considered
   *  - a unique index on invoice_line_items.plan_item_id makes double-billing
   *    impossible even under concurrency
   *  - the plan-level discount is apportioned onto the lines, so the invoice
   *    total equals the quoted plan total exactly
   *  - VAT is taken per line from the treatment's taxable flag, so exempt and
   *    taxable work can sit on one invoice
   */
  async generateFromPlan(
    planId: string,
    dto: GenerateInvoiceDto,
    actor: ClinicAuditActor,
  ) {
    const tenantId = this.tenant.getRequiredTenantId();
    const completedOnly = dto.completedOnly !== false;

    return this.db.withTenant(tenantId, async (client) => {
      const { rows: planRows } = await client.query<{
        id: string;
        patient_id: string;
        title: string;
        status: string;
        discount_amount: number;
      }>(
        `SELECT id, patient_id, title, status, discount_amount
           FROM treatment_plans WHERE id = $1 FOR UPDATE`,
        [planId],
      );
      const plan = planRows[0];
      if (!plan) throw new NotFoundException('Treatment plan not found');
      if (!['accepted', 'in_progress', 'completed'].includes(plan.status)) {
        throw new BadRequestException(
          `This plan is ${plan.status}. Only a plan the patient has accepted can be invoiced.`,
        );
      }

      // Candidate lines: not cancelled, not already billed, and — by default —
      // only work that has actually been done.
      const { rows: items } = await client.query<{
        id: string;
        description: string;
        quantity: number;
        unit_fee: number;
        discount_amount: number;
        tooth: number | null;
        status: string;
        treatment_id: string | null;
        procedure_code_id: string | null;
        treatment_taxable: boolean | null;
        code_taxable: boolean | null;
      }>(
        `SELECT i.id, i.description, i.quantity, i.unit_fee, i.discount_amount,
                i.tooth, i.status, i.treatment_id, i.procedure_code_id,
                t.is_taxable AS treatment_taxable,
                c.is_taxable AS code_taxable
           FROM treatment_plan_items i
           LEFT JOIN treatments t ON t.id = i.treatment_id
           LEFT JOIN procedure_codes c ON c.id = i.procedure_code_id
          WHERE i.plan_id = $1
            AND i.status <> 'cancelled'
            AND ($2::boolean IS FALSE OR i.status = 'completed')
            AND NOT EXISTS (
                  SELECT 1 FROM invoice_line_items l WHERE l.plan_item_id = i.id
                )
          ORDER BY i.sort_order, i.created_at`,
        [planId, completedOnly],
      );

      if (items.length === 0) {
        throw new BadRequestException(
          completedOnly
            ? 'No completed, unbilled procedures on this plan. Mark work completed first, or bill the whole plan.'
            : 'Every procedure on this plan has already been invoiced.',
        );
      }

      const config = await this.billingConfig(client);

      // Taxability comes from the service, not the invoice: exempt and taxable
      // work must be able to coexist on one bill.
      const planLines = items.map((i) => ({
        quantity: i.quantity,
        unitFee: i.unit_fee,
        discountAmount: i.discount_amount,
        taxRateBp: i.treatment_taxable || i.code_taxable ? config.vatRateBp : 0,
      }));

      /**
       * The plan discount only applies in full when the WHOLE plan is being
       * billed. Invoicing part of a plan and still deducting the entire
       * discount would give the patient the full reduction on a fraction of
       * the work, so it is pro-rated by the share being billed.
       */
      const { rows: allLines } = await client.query<{ net: string }>(
        `SELECT coalesce(sum(greatest(0, unit_fee * quantity - discount_amount)), 0)::text AS net
           FROM treatment_plan_items
          WHERE plan_id = $1 AND status <> 'cancelled'`,
        [planId],
      );
      const planNetTotal = Number(allLines[0]?.net ?? 0);
      const billingNet = planLines.reduce(
        (s, l) => s + Math.max(0, l.unitFee * l.quantity - l.discountAmount),
        0,
      );
      const applicableDiscount =
        planNetTotal > 0
          ? Math.round((plan.discount_amount * billingNet) / planNetTotal)
          : 0;

      const invoiceLines = planLinesToInvoiceLines(planLines, applicableDiscount);
      const totals = calculateInvoice(invoiceLines);

      // Per-tenant sequential number, retried on a concurrent clash. Same
      // SAVEPOINT pattern the ad-hoc invoice path uses: a 23505 aborts the
      // transaction, so the retry needs a point to roll back to.
      for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++) {
        await client.query('SAVEPOINT plan_invoice');
        try {
          const { rows: seqRows } = await client.query<{ next: number }>(
            'SELECT coalesce(max(seq), 0) + 1 AS next FROM invoices',
          );
          const seq = Number(seqRows[0]!.next);
          const number = await nextInvoiceNumber(client, seq);

          const { rows: invRows } = await client.query<{ id: string }>(
            `INSERT INTO invoices
               (tenant_id, patient_id, seq, invoice_number, treatment_plan_id,
                subtotal, discount_amount, tax_amount, total,
                currency, vat_rate_bp, issued_at, due_on, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                     coalesce($12::date, clinic_today()),
                     coalesce($12::date, clinic_today()) + ($13 || ' days')::interval,
                     $14,$15)
             RETURNING id`,
            [
              tenantId,
              plan.patient_id,
              seq,
              number,
              planId,
              totals.subtotal,
              totals.discountAmount,
              totals.taxAmount,
              totals.total,
              config.currency,
              config.vatRateBp,
              dto.issuedAt ?? null,
              String(config.paymentTermsDays),
              dto.notes ?? `Generated from treatment plan: ${plan.title}`,
              actor.userId,
            ],
          );
          const invoiceId = invRows[0]!.id;

          for (let idx = 0; idx < items.length; idx++) {
            const item = items[idx]!;
            const input = invoiceLines[idx]!;
            const cost = calculateInvoiceLine(input);
            await client.query(
              `INSERT INTO invoice_line_items
                 (tenant_id, invoice_id, treatment_id, procedure_code_id, plan_item_id,
                  tooth, description, quantity, unit_price, discount_amount,
                  tax_rate_bp, tax_amount, amount, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
              [
                tenantId,
                invoiceId,
                item.treatment_id,
                item.procedure_code_id,
                item.id,
                item.tooth,
                item.description,
                input.quantity,
                input.unitPrice,
                input.discountAmount,
                input.taxRateBp,
                cost.taxAmount,
                cost.total,
                idx,
              ],
            );
          }

          await client.query(
            `INSERT INTO ledger_entries
               (tenant_id, patient_id, invoice_id, entry_type, amount, currency,
                description, occurred_on, created_by)
             VALUES ($1,$2,$3,'charge',$4,$5,$6, coalesce($7::date, clinic_today()), $8)`,
            [
              tenantId,
              plan.patient_id,
              invoiceId,
              totals.total,
              config.currency,
              `Invoice ${number} — ${plan.title}`,
              dto.issuedAt ?? null,
              actor.userId,
            ],
          );

          // Billed lines move to completed so the plan reflects delivery.
          await client.query(
            `UPDATE treatment_plan_items SET status = 'completed', updated_at = now()
              WHERE id = ANY($1::uuid[]) AND status <> 'completed'`,
            [items.map((i) => i.id)],
          );

          await client.query('RELEASE SAVEPOINT plan_invoice');
          await this.audit.record(client, actor, {
            action: 'invoice.created',
            entityType: 'invoice',
            entityId: invoiceId,
            summary: `Issued ${number} for ${await moneyText(client, totals.total)} from plan "${plan.title}"`,
            metadata: {
              invoiceNumber: number,
              total: totals.total,
              planId,
              lineItems: items.length,
            },
          });
          return this.getInvoice(client, invoiceId);
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT plan_invoice');
          const code = (err as { code?: string }).code;
          if (code === UNIQUE_VIOLATION && attempt < MAX_SEQ_ATTEMPTS - 1) continue;
          if (code === UNIQUE_VIOLATION) {
            throw new ConflictException(
              'Could not allocate an invoice number, or one of these procedures was billed concurrently. Please retry.',
            );
          }
          throw err;
        }
      }
      throw new BadRequestException('Could not allocate an invoice number, please retry');
    });
  }

  private async getInvoice(client: PoolClient, id: string) {
    const { rows } = await client.query<{
      id: string;
      invoice_number: string;
      patient_id: string;
      patient_name: string;
      treatment_plan_id: string | null;
      plan_title: string | null;
      status: string;
      subtotal: number;
      discount_amount: number;
      tax_amount: number;
      total: number;
      currency: string;
      vat_rate_bp: number;
      issued_at: string;
      due_on: string | null;
      notes: string | null;
      paid: string;
    }>(
      `SELECT i.id, i.invoice_number, i.patient_id,
              (p.first_name || ' ' || p.last_name) AS patient_name,
              i.treatment_plan_id, tp.title AS plan_title,
              i.status, i.subtotal, i.discount_amount, i.tax_amount, i.total,
              i.currency, i.vat_rate_bp,
              i.issued_at::text AS issued_at, i.due_on::text AS due_on, i.notes,
              coalesce((SELECT sum(amount) FROM payments
                         WHERE invoice_id = i.id AND voided_at IS NULL), 0)::text AS paid
         FROM invoices i
         JOIN patients p ON p.id = i.patient_id
         LEFT JOIN treatment_plans tp ON tp.id = i.treatment_plan_id
        WHERE i.id = $1`,
      [id],
    );
    const inv = rows[0]!;

    const { rows: lines } = await client.query<{
      id: string;
      description: string;
      quantity: number;
      unit_price: number;
      discount_amount: number;
      tax_rate_bp: number;
      tax_amount: number;
      amount: number;
      tooth: number | null;
      code: string | null;
    }>(
      `SELECT l.id, l.description, l.quantity, l.unit_price, l.discount_amount,
              l.tax_rate_bp, l.tax_amount, l.amount, l.tooth, c.code
         FROM invoice_line_items l
         LEFT JOIN procedure_codes c ON c.id = l.procedure_code_id
        WHERE l.invoice_id = $1 ORDER BY l.sort_order, l.id`,
      [id],
    );

    const paid = Number(inv.paid);
    return {
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      patientId: inv.patient_id,
      patientName: inv.patient_name,
      treatmentPlanId: inv.treatment_plan_id,
      planTitle: inv.plan_title,
      status: inv.status,
      subtotal: inv.subtotal,
      discountAmount: inv.discount_amount,
      taxAmount: inv.tax_amount,
      total: inv.total,
      currency: inv.currency,
      vatRateBp: inv.vat_rate_bp,
      issuedAt: inv.issued_at,
      dueOn: inv.due_on,
      notes: inv.notes,
      paid,
      balance: inv.total - paid,
      items: lines.map((l) => ({
        id: l.id,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unit_price,
        discountAmount: l.discount_amount,
        taxRateBp: l.tax_rate_bp,
        taxAmount: l.tax_amount,
        amount: l.amount,
        tooth: l.tooth,
        code: l.code,
      })),
    };
  }

  /* ── ledger ── */

  async ledgerFor(patientId: string) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM patients WHERE id = $1', [
        patientId,
      ]);
      if (!rowCount) throw new NotFoundException('Patient not found');

      const { rows } = await client.query<{
        id: string;
        entry_type: LedgerEntryType;
        amount: number;
        currency: string;
        description: string;
        occurred_on: string;
        invoice_id: string | null;
        invoice_number: string | null;
        actor_name: string | null;
        created_at: string;
      }>(
        `SELECT l.id, l.entry_type, l.amount, l.currency, l.description,
                l.occurred_on::text AS occurred_on, l.invoice_id,
                i.invoice_number, u.full_name AS actor_name, l.created_at
           FROM ledger_entries l
           LEFT JOIN invoices i ON i.id = l.invoice_id
           LEFT JOIN users u ON u.id = l.created_by
          WHERE l.patient_id = $1
          ORDER BY l.occurred_on DESC, l.created_at DESC`,
        [patientId],
      );

      // Running balance is computed oldest-first, then presented newest-first,
      // so each row shows what was owed immediately after it.
      const oldestFirst = [...rows].reverse();
      let running = 0;
      const withBalance = oldestFirst.map((r) => {
        running += r.amount;
        return {
          id: r.id,
          entryType: r.entry_type,
          amount: r.amount,
          currency: r.currency,
          description: r.description,
          occurredOn: r.occurred_on,
          invoiceId: r.invoice_id,
          invoiceNumber: r.invoice_number,
          actorName: r.actor_name,
          createdAt: r.created_at,
          balanceAfter: running,
        };
      });

      const charged = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
      const credited = rows
        .filter((r) => r.amount < 0)
        .reduce((s, r) => s + -r.amount, 0);

      return {
        patientId,
        entries: withBalance.reverse(),
        balance: running,
        totalCharged: charged,
        totalCredited: credited,
      };
    });
  }

  /**
   * A correction is a NEW entry, never an edit. That is what makes the ledger
   * evidence rather than a cache — the history of what was believed at each
   * point survives the correction.
   */
  async addAdjustment(
    patientId: string,
    dto: LedgerAdjustmentDto,
    actor: ClinicAuditActor,
  ) {
    if (dto.amount <= 0) {
      throw new BadRequestException(
        'Enter a positive amount — the entry type decides whether it increases or reduces the balance.',
      );
    }
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM patients WHERE id = $1', [
        patientId,
      ]);
      if (!rowCount) throw new NotFoundException('Patient not found');

      const config = await this.billingConfig(client);
      const signed = dto.amount * LEDGER_SIGN[dto.entryType];

      // Stored with the key (0024), so a retry past the replay store fails on
      // the unique index instead of adjusting the balance twice.
      await client
        .query(
          `INSERT INTO ledger_entries
             (tenant_id, patient_id, entry_type, amount, currency, description,
              occurred_on, created_by, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6, coalesce($7::date, clinic_today()), $8, $9)`,
          [
            tenantId,
            patientId,
            dto.entryType,
            signed,
            config.currency,
            dto.description.trim(),
            dto.occurredOn ?? null,
            actor.userId,
            this.request.get()?.idempotencyKey ?? null,
          ],
        )
        .catch((err: { code?: string; constraint?: string }) => {
          if (
            err.code === '23505' &&
            err.constraint === 'ledger_entries_idempotency_key_unique'
          ) {
            throw new ConflictException({
              code: 'adjustment_already_recorded',
              message:
                'This adjustment was already recorded. Refresh the account to see it.',
            });
          }
          throw err;
        });
      await this.audit.record(client, actor, {
        action: 'invoice.adjusted',
        entityType: 'patient',
        entityId: patientId,
        summary: `${dto.entryType.replace('_', ' ')} of ${await moneyText(client, dto.amount)} — ${dto.description.trim()}`,
        metadata: {
          entryType: dto.entryType,
          amount: dto.amount,
          signed,
          description: dto.description.trim(),
        },
      });
      return this.ledgerFor(patientId);
    });
  }

  /* ── accounts receivable ── */

  /**
   * Everything still owed, aged by how long the invoice has been outstanding.
   * Ageing is computed in SQL from issued_at so it cannot drift with the
   * server's clock between rows.
   */
  async accountsReceivable() {
    return this.tx(async (client) => {
      const { rows } = await client.query<{
        id: string;
        invoice_number: string;
        patient_id: string;
        patient_name: string;
        total: number;
        paid: string;
        issued_at: string;
        due_on: string | null;
        days_outstanding: number;
        currency: string;
      }>(
        `SELECT i.id, i.invoice_number, i.patient_id,
                (p.first_name || ' ' || p.last_name) AS patient_name,
                i.total,
                coalesce((SELECT sum(amount) FROM payments
                         WHERE invoice_id = i.id AND voided_at IS NULL), 0)::text AS paid,
                i.issued_at::text AS issued_at, i.due_on::text AS due_on,
                (clinic_today() - i.issued_at)::int AS days_outstanding,
                i.currency
           FROM invoices i
           JOIN patients p ON p.id = i.patient_id
          WHERE i.status IN ('unpaid','partially_paid')
          ORDER BY i.issued_at`,
      );

      const buckets: Record<AgeingBucketKey, { amount: number; count: number }> = {
        current: { amount: 0, count: 0 },
        d31_60: { amount: 0, count: 0 },
        d61_90: { amount: 0, count: 0 },
        over_90: { amount: 0, count: 0 },
      };

      const outstanding = rows
        .map((r) => {
          const balance = r.total - Number(r.paid);
          return {
            invoiceId: r.id,
            invoiceNumber: r.invoice_number,
            patientId: r.patient_id,
            patientName: r.patient_name,
            total: r.total,
            paid: Number(r.paid),
            balance,
            issuedAt: r.issued_at,
            dueOn: r.due_on,
            daysOutstanding: r.days_outstanding,
            bucket: bucketFor(r.days_outstanding),
            currency: r.currency,
          };
        })
        .filter((r) => r.balance > 0);

      for (const r of outstanding) {
        buckets[r.bucket].amount += r.balance;
        buckets[r.bucket].count += 1;
      }

      return {
        totalOutstanding: outstanding.reduce((s, r) => s + r.balance, 0),
        invoiceCount: outstanding.length,
        buckets: AGEING_BUCKETS.map((b) => ({
          key: b.key,
          label: b.label,
          amount: buckets[b.key].amount,
          count: buckets[b.key].count,
        })),
        invoices: outstanding,
      };
    });
  }

  /** Which patients carry a balance, worst first. */
  async patientBalances() {
    return this.tx(async (client) => {
      const { rows } = await client.query<{
        patient_id: string;
        patient_name: string;
        balance: string;
        last_activity: string;
      }>(
        `SELECT l.patient_id,
                (p.first_name || ' ' || p.last_name) AS patient_name,
                sum(l.amount)::text AS balance,
                max(l.occurred_on)::text AS last_activity
           FROM ledger_entries l
           JOIN patients p ON p.id = l.patient_id
          GROUP BY l.patient_id, p.first_name, p.last_name
         HAVING sum(l.amount) <> 0
          ORDER BY sum(l.amount) DESC`,
      );
      return rows.map((r) => ({
        patientId: r.patient_id,
        patientName: r.patient_name,
        balance: Number(r.balance),
        lastActivity: r.last_activity,
      }));
    });
  }
}
