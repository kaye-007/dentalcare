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
import { ClinicAuditService, ClinicAuditActor } from '@/core/audit/clinic-audit.service';
import { CashDrawerService } from '@/modules/clinic/cash-drawer/cash-drawer.service';
import { moneyText } from '@/core/money/clinic-currency';
import { nextInvoiceNumber } from '@/core/money/invoice-number';
import { vatCategoryOf, vatRateFor } from '@dentalcare/shared';
import {
  calculateInvoice,
  calculateInvoiceLine,
  deriveInvoiceStatus,
} from './billing-engine';
import { CreateExpenseDto, CreateInvoiceDto, RecordPaymentDto } from './dto/finance.dto';

/* ════════ Service ════════ */
interface InvRow {
  id: string;
  invoice_number: string;
  status: string;
  total: number;
  subtotal: number;
  tax_amount: number;
  currency: string;
  issued_at: string;
  patient_id: string;
  patient_name: string;
  paid: string | number;
  document_kind: string;
}

const INV_SELECT = `
  SELECT i.id, i.invoice_number, i.status, i.total, i.subtotal, i.tax_amount, i.currency,
         i.issued_at::text AS issued_at, i.document_kind,
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
  /** TVSH on the invoice, minor units. Zero when every line is exempt. */
  taxAmount: r.tax_amount,
  currency: r.currency,
  paid: Number(r.paid),
  balance: r.total - Number(r.paid),
  issuedAt: r.issued_at,
  patientId: r.patient_id,
  patientName: r.patient_name,
  /** What the clinic meant to issue (0015); the fiscal record says what happened. */
  documentKind: (r.document_kind ?? 'internal') as 'internal' | 'fiscal',
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

/**
 * The kind a payment is recorded as, and the clinic's own name for it.
 *
 * A clinic method ("POS Credins") resolves to its kind, which is what the
 * ledger, the reports and the tax authority understand. A request naming
 * only a kind — every client written before 0009 — still works.
 */
async function paymentMethodOf(
  client: PoolClient,
  dto: RecordPaymentDto,
): Promise<{ kind: 'cash' | 'card' | 'bank'; label: string | null }> {
  if (dto.methodId) {
    const { rows } = await client.query<{ payment_methods: unknown }>(
      'SELECT payment_methods FROM clinic_settings LIMIT 1',
    );
    const list = Array.isArray(rows[0]?.payment_methods)
      ? (rows[0]!.payment_methods as {
          id: string;
          label: string;
          kind: string;
          active: boolean;
        }[])
      : [];
    const found = list.find((m) => m.id === dto.methodId && m.active);
    if (
      found &&
      (found.kind === 'cash' || found.kind === 'card' || found.kind === 'bank')
    ) {
      return { kind: found.kind, label: found.label };
    }
    // The built-in three exist even when a clinic has never edited the list.
    if (!list.length && ['cash', 'card', 'bank'].includes(dto.methodId)) {
      return { kind: dto.methodId as 'cash' | 'card' | 'bank', label: null };
    }
    throw new BadRequestException('That payment method is not one this clinic accepts');
  }
  if (!dto.method) throw new BadRequestException('Choose how the payment was made');
  return { kind: dto.method, label: null };
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
    private readonly request: RequestContextService,
    private readonly drawer: CashDrawerService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /* ── invoices ── */
  listInvoices(opts: { q?: string; status?: string; patientId?: string }) {
    return this.tx(async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      // "open" is the two statuses that still owe: what the record and the
      // dashboard ask for, without fetching everything to filter it locally.
      if (opts.status === 'open') {
        where.push(`i.status IN ('unpaid','partially_paid')`);
      } else if (
        opts.status &&
        ['unpaid', 'partially_paid', 'paid', 'cancelled'].includes(opts.status)
      ) {
        params.push(opts.status);
        where.push(`i.status = $${params.length}`);
      }
      if (opts.patientId) {
        params.push(opts.patientId);
        where.push(`i.patient_id = $${params.length}`);
      }
      if (opts.q?.trim()) {
        params.push(`%${opts.q.trim()}%`);
        const k = params.length;
        where.push(
          `(i.invoice_number ILIKE $${k} OR (p.first_name || ' ' || p.last_name) ILIKE $${k})`,
        );
      }
      const { rows } = await client.query<InvRow>(
        `${INV_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY i.seq DESC LIMIT 200`,
        params,
      );
      return rows.map(mapInv);
    });
  }

  /**
   * Completed work on the chart that no invoice covers yet — what **Bill**
   * pre-fills, so reception confirms the dentist's record instead of typing
   * it again.
   *
   * A procedure is covered when a live invoice line points at it (or at its
   * plan item). Work charted before lines could point at procedures was
   * billed by hand, so an unlinked procedure is also treated as covered once
   * the patient has a hand-built invoice created after it. That errs towards
   * suggesting too little: a missed suggestion costs a tap in the service
   * picker, a wrong one could bill the same work twice. Only the last 30
   * days are offered.
   */
  unbilledProcedures(patientId: string) {
    return this.tx(async (client) => {
      const { rows } = await client.query<{
        id: string;
        tooth: number | null;
        description: string;
        fee: number;
        performed_on: string;
        treatment_id: string | null;
        is_taxable: boolean | null;
        clinician_name: string | null;
      }>(
        `SELECT cp.id, cp.tooth, cp.description, cp.fee, cp.performed_on::text AS performed_on,
                cp.treatment_id, t.is_taxable, u.full_name AS clinician_name
           FROM clinical_procedures cp
           LEFT JOIN treatments t ON t.id = cp.treatment_id
           LEFT JOIN users u ON u.id = cp.clinician_id
          WHERE cp.patient_id = $1
            AND cp.status = 'completed'
            AND cp.entered_in_error_at IS NULL
            AND cp.performed_on >= clinic_today() - 30
            AND NOT EXISTS (
                  SELECT 1 FROM invoice_line_items li
                    JOIN invoices i ON i.id = li.invoice_id
                   WHERE i.status <> 'cancelled'
                     AND (li.procedure_id = cp.id
                          OR (cp.plan_item_id IS NOT NULL AND li.plan_item_id = cp.plan_item_id)))
            AND NOT EXISTS (
                  SELECT 1 FROM invoices i
                   WHERE i.patient_id = cp.patient_id
                     AND i.status <> 'cancelled'
                     AND i.created_at > cp.created_at
                     AND NOT EXISTS (SELECT 1 FROM invoice_line_items li
                                      WHERE li.invoice_id = i.id AND li.procedure_id IS NOT NULL))
          ORDER BY cp.performed_on, cp.created_at
          LIMIT 50`,
        [patientId],
      );
      return rows.map((r) => ({
        procedureId: r.id,
        tooth: r.tooth,
        description: r.description,
        fee: r.fee,
        performedOn: r.performed_on,
        treatmentId: r.treatment_id,
        vatCategory: vatCategoryOf(r.is_taxable),
        clinicianName: r.clinician_name,
      }));
    });
  }

  getInvoice(id: string) {
    return this.tx(async (client) => {
      const inv = await client.query<InvRow>(`${INV_SELECT} WHERE i.id = $1`, [id]);
      if (!inv.rows[0]) throw new NotFoundException('Invoice not found');
      const items = await client.query(
        `SELECT li.id, li.description, li.quantity, li.unit_price, li.amount,
                li.discount_amount, li.tax_rate_bp, li.tax_amount,
                li.treatment_id, t.name AS treatment_name
           FROM invoice_line_items li
           LEFT JOIN treatments t ON t.id = li.treatment_id
          WHERE li.invoice_id = $1 ORDER BY li.sort_order, li.id`,
        [id],
      );
      // Voided payments are still listed — struck through, with who and why.
      // Hiding them would defeat the point of not deleting them.
      const pays = await client.query(
        `SELECT pay.id, pay.amount, pay.method, pay.method_label, pay.note, pay.paid_at,
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
          discountAmount: r.discount_amount,
          taxRateBp: r.tax_rate_bp,
          taxAmount: r.tax_amount,
          /** Including TVSH. */
          amount: r.amount,
          treatmentId: r.treatment_id,
          treatmentName: r.treatment_name,
        })),
        payments: pays.rows.map((r) => ({
          id: r.id,
          amount: r.amount,
          method: r.method,
          methodLabel: r.method_label,
          note: r.note,
          paidAt: r.paid_at,
          recordedBy: r.recorded_by,
          // Selected all along and then dropped here, so the invoice screen
          // never showed a voided payment as voided.
          voidedAt: r.voided_at,
          voidReason: r.void_reason,
          voidedByName: r.voided_by_name,
        })),
      };
    });
  }

  createInvoice(dto: CreateInvoiceDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const pat = await client.query('SELECT 1 FROM patients WHERE id = $1', [
        dto.patientId,
      ]);
      if (!pat.rowCount) throw new NotFoundException('Patient not found');
      const taxable = new Map<string, boolean>();
      for (const it of dto.items) {
        if (it.treatmentId && !taxable.has(it.treatmentId)) {
          const t = await client.query<{ is_taxable: boolean }>(
            'SELECT is_taxable FROM treatments WHERE id = $1',
            [it.treatmentId],
          );
          if (!t.rows[0]) throw new NotFoundException('Treatment not found');
          taxable.set(it.treatmentId, t.rows[0].is_taxable);
        }
      }

      // Lines that bill charted work. Locked, so two desks billing the same
      // visit at once cannot both succeed; checked, so work is billed once.
      const procIds = dto.items.flatMap((it) => (it.procedureId ? [it.procedureId] : []));
      const procs = new Map<
        string,
        { tooth: number | null; plan_item_id: string | null }
      >();
      if (procIds.length) {
        if (new Set(procIds).size !== procIds.length) {
          throw new BadRequestException(
            'The same treatment is on two lines of this invoice',
          );
        }
        const { rows } = await client.query<{
          id: string;
          tooth: number | null;
          plan_item_id: string | null;
        }>(
          `SELECT id, tooth, plan_item_id FROM clinical_procedures
            WHERE id = ANY($1::uuid[]) AND patient_id = $2
              AND status = 'completed' AND entered_in_error_at IS NULL
            FOR UPDATE`,
          [procIds, dto.patientId],
        );
        if (rows.length !== procIds.length) {
          throw new BadRequestException(
            'One of these treatments can no longer be billed. It may have been withdrawn or changed; reopen the invoice to see the current list.',
          );
        }
        for (const r of rows)
          procs.set(r.id, { tooth: r.tooth, plan_item_id: r.plan_item_id });
        const planItems = rows.flatMap((r) => (r.plan_item_id ? [r.plan_item_id] : []));
        const { rows: billed } = await client.query<{ invoice_number: string }>(
          `SELECT i.invoice_number
             FROM invoice_line_items li
             JOIN invoices i ON i.id = li.invoice_id
            WHERE i.status <> 'cancelled'
              AND (li.procedure_id = ANY($1::uuid[]) OR li.plan_item_id = ANY($2::uuid[]))
            LIMIT 1`,
          [procIds, planItems],
        );
        if (billed[0]) {
          throw new ConflictException(
            `Some of this work is already billed on ${billed[0].invoice_number}.`,
          );
        }
      }

      // TVSH per line. This path used to write every line at 0% whatever the
      // treatment was, so cosmetic work billed here carried no VAT while the
      // same work billed from a plan did. Both paths now take the rate from
      // the treatment's category and the clinic's rate, through one engine.
      const { rows: cfg } = await client.query<{ vat_rate_bp: number }>(
        'SELECT vat_rate_bp FROM clinic_settings LIMIT 1',
      );
      const clinicRateBp = cfg[0]?.vat_rate_bp ?? 0;
      const lines = dto.items.map((it) => {
        const category =
          it.vatCategory ??
          vatCategoryOf(it.treatmentId ? taxable.get(it.treatmentId) : false);
        const input = {
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          discountAmount: 0,
          taxRateBp: vatRateFor(category, clinicRateBp),
        };
        return { item: it, input, cost: calculateInvoiceLine(input) };
      });
      const totals = calculateInvoice(lines.map((l) => l.input));
      const total = totals.total;

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
          const number = await nextInvoiceNumber(client, seq);
          const ins = await client.query<{ id: string }>(
            `INSERT INTO invoices
               (tenant_id, patient_id, seq, invoice_number, subtotal, tax_amount, total,
                vat_rate_bp, issued_at, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::date, clinic_today()), $10) RETURNING id`,
            [
              tenantId,
              dto.patientId,
              seq,
              number,
              totals.subtotal,
              totals.taxAmount,
              total,
              clinicRateBp,
              dto.issuedAt ?? null,
              actor.userId,
            ],
          );
          const invoiceId = ins.rows[0]!.id;
          for (const [idx, { item, input, cost }] of lines.entries()) {
            const proc = item.procedureId ? procs.get(item.procedureId) : undefined;
            await client.query(
              `INSERT INTO invoice_line_items
                 (tenant_id, invoice_id, treatment_id, description, quantity, unit_price,
                  tax_rate_bp, tax_amount, amount, sort_order, procedure_id, plan_item_id, tooth)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [
                tenantId,
                invoiceId,
                item.treatmentId ?? null,
                item.description,
                input.quantity,
                input.unitPrice,
                input.taxRateBp,
                cost.taxAmount,
                cost.total,
                idx,
                item.procedureId ?? null,
                proc?.plan_item_id ?? null,
                proc?.tooth ?? null,
              ],
            );
          }
          // The ledger is written inside the SAME transaction as the invoice.
          // A charge that could exist without its ledger entry would make the
          // patient balance quietly wrong, and nothing would report the gap.
          await client.query(
            `INSERT INTO ledger_entries
               (tenant_id, patient_id, invoice_id, entry_type, amount, description,
                occurred_on, created_by)
             VALUES ($1,$2,$3,'charge',$4,$5, coalesce($6::date, clinic_today()), $7)`,
            [
              tenantId,
              dto.patientId,
              invoiceId,
              total,
              `Invoice ${number}`,
              dto.issuedAt ?? null,
              actor.userId,
            ],
          );
          await client.query('RELEASE SAVEPOINT invoice_seq');
          await this.audit.record(client, actor, {
            action: 'invoice.created',
            entityType: 'invoice',
            entityId: invoiceId,
            summary: `Issued ${number} for ${await moneyText(client, total)}`,
            metadata: {
              invoiceNumber: number,
              total,
              taxAmount: totals.taxAmount,
              lineItems: dto.items.length,
              ...(procIds.length ? { chartedProcedures: procIds.length } : {}),
            },
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

  /**
   * Cancel an unpaid invoice.
   *
   * Two things this used to get wrong. It set the status without
   * `cancelled_at`, which the invoice_cancel_consistent constraint requires,
   * so every cancellation failed with a 500. And it left the invoice's charge
   * on the patient's ledger, so the account went on saying they owed money
   * for a bill that no longer existed. The charge now comes off as a new,
   * opposite entry — the ledger is never edited.
   */
  cancelInvoice(id: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const cur = await client.query<{
        status: string;
        paid: string;
        invoice_number: string;
        patient_id: string;
        charged: string;
      }>(
        `SELECT status, invoice_number, patient_id,
                coalesce((SELECT sum(amount) FROM payments
                           WHERE invoice_id = $1 AND voided_at IS NULL), 0) AS paid,
                coalesce((SELECT sum(amount) FROM ledger_entries
                           WHERE invoice_id = $1
                             AND entry_type IN ('charge', 'adjustment')), 0) AS charged
           FROM invoices WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = cur.rows[0];
      if (!row) throw new NotFoundException('Invoice not found');
      if (row.status === 'cancelled')
        throw new BadRequestException('Invoice is already cancelled');
      if (Number(row.paid) > 0) {
        throw new BadRequestException(
          'An invoice with recorded payments cannot be cancelled',
        );
      }
      await client.query(
        `UPDATE invoices SET status = 'cancelled', cancelled_at = now(), updated_at = now()
          WHERE id = $1`,
        [id],
      );

      // Reverse exactly what this invoice put on the account. An invoice from
      // before the ledger existed has nothing there, and gets nothing taken off.
      const charged = Number(row.charged);
      if (charged > 0) {
        await client.query(
          `INSERT INTO ledger_entries
             (tenant_id, patient_id, invoice_id, entry_type, amount, description, created_by)
           VALUES ($1,$2,$3,'adjustment',$4,$5,$6)`,
          [
            this.tenant.getRequiredTenantId(),
            row.patient_id,
            id,
            -charged,
            `Invoice ${row.invoice_number} cancelled`,
            actor.userId,
          ],
        );
      }

      await this.audit.record(client, actor, {
        action: 'invoice.cancelled',
        entityType: 'invoice',
        entityId: id,
        summary: `Cancelled ${row.invoice_number}${
          charged > 0
            ? ` and reversed its ${await moneyText(client, charged)} charge`
            : ''
        }`,
        metadata: {
          invoiceNumber: row.invoice_number,
          previousStatus: row.status,
          reversed: charged,
        },
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
      if (inv.status === 'cancelled')
        throw new BadRequestException('Cannot pay a cancelled invoice');
      const balance = inv.total - Number(inv.paid);
      if (balance <= 0)
        throw new BadRequestException('This invoice is already fully paid');
      if (dto.amount > balance) {
        throw new BadRequestException(
          `Amount exceeds the outstanding balance (${await moneyText(client, balance)})`,
        );
      }
      const how = await paymentMethodOf(client, dto);
      const document = await this.resolveDocument(client, invoiceId, dto.document);

      // Cash goes into the receptionist's open drawer session when the clinic
      // uses the cash drawer (0014); with no open drawer the payment is refused
      // here, before anything is written.
      const drawerSessionId =
        how.kind === 'cash'
          ? await this.drawer.sessionForCashPayment(client, actor)
          : null;

      // The Idempotency-Key, when the request carried one, is stored on the
      // payment. A retry that slips past the interceptor fails on the unique
      // index instead of taking the money twice.
      const idempotencyKey = this.request.get()?.idempotencyKey ?? null;
      const { rows: payRows } = await client
        .query<{ id: string }>(
          `INSERT INTO payments
             (tenant_id, invoice_id, amount, method, method_label, note, created_by,
              drawer_session_id, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            tenantId,
            invoiceId,
            dto.amount,
            how.kind,
            how.label,
            dto.note ?? null,
            actor.userId,
            drawerSessionId,
            idempotencyKey,
          ],
        )
        .catch((err: { code?: string; constraint?: string }) => {
          if (
            err.code === '23505' &&
            err.constraint === 'payments_idempotency_key_unique'
          ) {
            throw new ConflictException({
              code: 'payment_already_recorded',
              message:
                'This payment was already recorded. Refresh the invoice to see it.',
            });
          }
          throw err;
        });
      if (drawerSessionId) {
        await this.drawer.recordCashSale(
          client,
          actor,
          drawerSessionId,
          payRows[0]!.id,
          dto.amount,
        );
      }

      // Ledger amounts are SIGNED: a payment reduces what the patient owes,
      // so a balance is one SUM rather than a reconciliation.
      const { rows: who } = await client.query<{
        patient_id: string;
        invoice_number: string;
      }>('SELECT patient_id, invoice_number FROM invoices WHERE id = $1', [invoiceId]);
      await client.query(
        `INSERT INTO ledger_entries
           (tenant_id, patient_id, invoice_id, payment_id, entry_type, amount,
            description, created_by)
         VALUES ($1,$2,$3,$4,'payment',$5,$6,$7)`,
        [
          tenantId,
          who[0]!.patient_id,
          invoiceId,
          payRows[0]!.id,
          -dto.amount,
          `Payment (${how.label ?? how.kind}) for ${who[0]!.invoice_number}`,
          actor.userId,
        ],
      );

      const newPaid = Number(inv.paid) + dto.amount;
      await client.query(
        `UPDATE invoices
            SET status = $1, updated_at = now(),
                document_kind = $3, document_chosen_by = $4, document_chosen_at = now()
          WHERE id = $2`,
        [statusFor(inv.total, newPaid), invoiceId, document, actor.userId],
      );
      await this.audit.record(client, actor, {
        action: 'payment.recorded',
        entityType: 'payment',
        entityId: payRows[0]!.id,
        summary: `Took ${await moneyText(client, dto.amount)} by ${how.label ?? how.kind} against ${who[0]!.invoice_number}${
          document === 'internal' ? ' as an internal receipt (not fiscalized)' : ''
        }`,
        metadata: {
          amount: dto.amount,
          method: how.kind,
          methodLabel: how.label,
          invoiceId,
          invoiceNumber: who[0]!.invoice_number,
          document,
        },
      });
      return {
        ...(await this.getInvoiceWithin(client, invoiceId)),
        documentKind: document,
      };
    });
  }

  /**
   * Which document this payment issues.
   *
   * An invoice already registered with the authority is fiscal and stays
   * fiscal — the registration exists at CIS and no later payment can take it
   * back. Otherwise the caller decides; with no choice sent, the clinic's
   * default applies, and `ask` means the client should have chosen, so it is
   * refused rather than guessed at.
   *
   * The internal receipt can be switched off for the clinic entirely, which
   * is the setting a practice uses when everything it takes is fiscalized.
   */
  private async resolveDocument(
    client: PoolClient,
    invoiceId: string,
    chosen: 'internal' | 'fiscal' | undefined,
  ): Promise<'internal' | 'fiscal'> {
    const { rows } = await client.query<{
      registered: boolean;
      default_checkout_mode: string | null;
      internal_receipts_enabled: boolean | null;
    }>(
      `SELECT EXISTS (SELECT 1 FROM fiscal_invoices f WHERE f.invoice_id = $1) AS registered,
              s.default_checkout_mode, s.internal_receipts_enabled
         FROM clinic_settings s
        WHERE s.tenant_id = $2`,
      [invoiceId, this.tenant.getRequiredTenantId()],
    );
    const row = rows[0];
    if (row?.registered) return 'fiscal';

    const fallback = row?.default_checkout_mode ?? 'fiscal';
    const document =
      chosen ?? (fallback === 'ask' ? undefined : (fallback as 'internal' | 'fiscal'));
    if (!document) {
      throw new BadRequestException({
        code: 'checkout_document_required',
        message:
          'Choose whether this payment issues a fiscal invoice or an internal receipt.',
      });
    }
    if (document === 'internal' && row?.internal_receipts_enabled === false) {
      throw new BadRequestException({
        code: 'internal_receipts_disabled',
        message:
          'This clinic issues fiscal invoices only. Internal receipts are turned off in Settings.',
      });
    }
    return document;
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
        invoice_id: string;
        amount: number;
        method: string;
        voided_at: string | null;
        invoice_number: string;
        patient_id: string;
        invoice_status: string;
        total: number;
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

      // A cash payment taken into a drawer comes back off it (0014).
      if (pay.method === 'cash') {
        await this.drawer.recordCashVoid(
          client,
          actor,
          paymentId,
          pay.amount,
          reason.trim(),
        );
      }

      // The reversal is a NEW entry, never an edit of the old one: a ledger
      // that can be rewritten is a cache, not evidence. `refund` carries sign
      // +1 in LEDGER_SIGN — the patient owes this again.
      await client.query(
        `INSERT INTO ledger_entries
           (tenant_id, patient_id, invoice_id, payment_id, entry_type, amount,
            description, created_by)
         VALUES ($1,$2,$3,$4,'refund',$5,$6,$7)`,
        [
          tenantId,
          pay.patient_id,
          pay.invoice_id,
          paymentId,
          pay.amount,
          `Voided payment (${pay.method}) on ${pay.invoice_number}`,
          actor.userId,
        ],
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
        summary: `Voided ${await moneyText(client, pay.amount)} (${pay.method}) on ${pay.invoice_number} — ${reason.trim()}`,
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
        `SELECT pay.id, pay.amount, pay.method, pay.method_label, pay.note, pay.paid_at,
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
        methodLabel: r.method_label,
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
         VALUES ($1,$2,$3, coalesce($4::date, clinic_today()), $5, $6)
         RETURNING id, category, amount, expense_date::text AS expense_date, note`,
        [
          tenantId,
          dto.category,
          dto.amount,
          dto.expenseDate ?? null,
          dto.note ?? null,
          actor.userId,
        ],
      );
      const r = rows[0]!;
      await this.audit.record(client, actor, {
        action: 'expense.recorded',
        entityType: 'expense',
        entityId: r.id,
        summary: `Recorded ${await moneyText(client, r.amount)} of ${r.category} spending`,
        metadata: { amount: r.amount, category: r.category, expenseDate: r.expense_date },
      });
      return {
        id: r.id,
        category: r.category,
        amount: r.amount,
        expenseDate: r.expense_date,
        note: r.note,
      };
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
        category: string;
        amount: number;
        voided_at: string | null;
      }>('SELECT category, amount, voided_at FROM expenses WHERE id = $1 FOR UPDATE', [
        id,
      ]);
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
        summary: `Voided ${await moneyText(client, exp.amount)} of ${exp.category} spending — ${reason.trim()}`,
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
  summary(period: 'today' | 'month' | 'all', includeAggregates: boolean) {
    return this.tx(async (client) => {
      // Periods are the clinic's days and months, not the database's. On UTC,
      // a payment taken at 00:30 on the 1st in Tirana counted towards the
      // previous month, and "today" would end at 02:00 local time.
      const { rows: zone } = await client.query<{
        from_d: string | null;
        to_d: string | null;
      }>(
        `WITH local AS (SELECT clinic_today() AS d)
         SELECT CASE $1 WHEN 'today' THEN d WHEN 'month' THEN date_trunc('month', d)::date END::text AS from_d,
                CASE $1 WHEN 'today' THEN d + 1 WHEN 'month' THEN (date_trunc('month', d) + interval '1 month')::date END::text AS to_d
           FROM local`,
        [period],
      );
      const range = period === 'all' ? null : [zone[0]!.from_d, zone[0]!.to_d];
      const tzSql = 'clinic_zone()';
      const invFilter = range ? `AND issued_at >= $1::date AND issued_at < $2::date` : '';
      const payFilter = range
        ? `AND (paid_at AT TIME ZONE ${tzSql})::date >= $1::date AND (paid_at AT TIME ZONE ${tzSql})::date < $2::date`
        : '';
      const expFilter = range
        ? `AND expense_date >= $1::date AND expense_date < $2::date`
        : '';
      const args = range ?? [];

      const invoiced = await client.query<{ s: string }>(
        `SELECT coalesce(sum(total),0) AS s FROM invoices WHERE status <> 'cancelled' ${invFilter}`,
        args,
      );
      const collected = await client.query<{ s: string }>(
        `SELECT coalesce(sum(amount),0) AS s FROM payments
          WHERE voided_at IS NULL ${payFilter}`,
        args,
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
        args,
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
