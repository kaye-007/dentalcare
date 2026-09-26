import { Injectable, NotFoundException } from '@nestjs/common';
import qrcode from 'qrcode-generator';
import { isCurrency } from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { StorageService } from '@/core/storage/storage.service';
import { fiscalRecordFor } from '@/modules/clinic/fiscalization/fiscal.service';
import { renderInvoicePdf, type InvoicePdfData } from './invoice-pdf';

const METHOD_LABEL: Record<string, string> = { cash: 'Cash', card: 'Card', bank: 'Bank transfer' };

/** The QR code's modules, medium error correction, as the PDF writer draws them. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

@Injectable()
export class InvoicePdfService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly storage: StorageService,
  ) {}

  async render(invoiceId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    const tenantId = this.tenant.getRequiredTenantId();
    const data = await this.db.withTenant(tenantId, async (client) => {
      const { rows: inv } = await client.query(
        `SELECT i.invoice_number, i.status, i.issued_at::text AS issued_at, i.due_on::text AS due_on,
                i.currency, i.subtotal, i.discount_amount, i.tax_amount, i.total, i.notes,
                p.first_name, p.last_name, p.address, p.city, p.phone,
                coalesce((SELECT sum(amount) FROM payments
                           WHERE invoice_id = i.id AND voided_at IS NULL), 0)::int AS paid
           FROM invoices i JOIN patients p ON p.id = i.patient_id
          WHERE i.id = $1`,
        [invoiceId],
      );
      const i = inv[0];
      if (!i) throw new NotFoundException('Invoice not found');

      const { rows: items } = await client.query(
        `SELECT description, quantity, unit_price, discount_amount, tax_rate_bp, amount
           FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order, id`,
        [invoiceId],
      );
      const { rows: payments } = await client.query(
        `SELECT paid_at, method, method_label, amount FROM payments
          WHERE invoice_id = $1 AND voided_at IS NULL ORDER BY paid_at`,
        [invoiceId],
      );
      const { rows: clinicRows } = await client.query(
        `SELECT t.name, cs.legal_name, cs.address, cs.city, cs.phone, cs.email, cs.website,
                cs.tax_number, cs.registration_number, cs.brand_color, cs.logo_storage_key,
                coalesce(fs.enabled, false) AS fiscal_enabled
           FROM tenants t
           LEFT JOIN clinic_settings cs ON cs.tenant_id = t.id
           LEFT JOIN clinic_fiscal_settings fs ON fs.tenant_id = t.id
          WHERE t.id = $1`,
        [tenantId],
      );
      const fiscal = await fiscalRecordFor(client, invoiceId);
      const { rows: cashier } = fiscal
        ? await client.query<{ full_name: string | null }>(
            'SELECT u.full_name FROM fiscal_invoices f LEFT JOIN users u ON u.id = f.created_by WHERE f.invoice_id = $1',
            [invoiceId],
          )
        : { rows: [] };
      return { i, items, payments, clinic: clinicRows[0], fiscal, cashierName: cashier[0]?.full_name ?? null };
    });

    // Invoices issued before per-line totals existed carry zeros there; the
    // lines are the truth.
    const lineGross = data.items.reduce((s, l) => s + l.quantity * l.unit_price, 0);
    const lineDiscount = data.items.reduce((s, l) => s + l.discount_amount, 0);
    const lineTax = data.items.reduce((s, l) => s + (l.amount - (l.quantity * l.unit_price - l.discount_amount)), 0);

    const logo =
      data.clinic?.logo_storage_key && this.storage.isConfigured
        ? await this.storage.get(data.clinic.logo_storage_key, 1024 * 1024)
        : null;

    const pdf: InvoicePdfData = {
      clinic: {
        name: data.clinic?.name ?? '',
        legalName: data.clinic?.legal_name ?? null,
        address: data.clinic?.address ?? null,
        city: data.clinic?.city ?? null,
        phone: data.clinic?.phone ?? null,
        email: data.clinic?.email ?? null,
        website: data.clinic?.website ?? null,
        taxNumber: data.clinic?.tax_number ?? null,
        registrationNumber: data.clinic?.registration_number ?? null,
        brandColor: data.clinic?.brand_color ?? null,
        logo,
        fiscalizationEnabled: Boolean(data.clinic?.fiscal_enabled),
      },
      invoice: {
        number: data.i.invoice_number,
        status: data.i.status,
        issuedAt: data.i.issued_at,
        dueOn: data.i.due_on,
        currency: isCurrency(data.i.currency) ? data.i.currency : 'EUR',
        subtotal: data.i.subtotal || lineGross,
        discount: data.i.discount_amount || lineDiscount,
        tax: data.i.tax_amount || Math.max(0, lineTax),
        total: data.i.total,
        paid: data.i.paid,
        notes: data.i.notes,
      },
      patient: {
        name: `${data.i.first_name} ${data.i.last_name}`,
        address: data.i.address,
        city: data.i.city,
        phone: data.i.phone,
      },
      items: data.items.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unit_price,
        discount: l.discount_amount,
        taxRateBp: l.tax_rate_bp,
        amount: l.amount,
      })),
      payments: data.payments.map((p) => ({
        paidAt: new Date(p.paid_at).toISOString(),
        method: p.method_label ?? METHOD_LABEL[p.method] ?? p.method,
        amount: p.amount,
      })),
      fiscal: data.fiscal
        ? {
            status: data.fiscal.status,
            environment: data.fiscal.environment,
            nivf: data.fiscal.nivf,
            nslf: data.fiscal.nslf,
            invNum: data.fiscal.invNum,
            issueDateTime: data.fiscal.issueDateTime,
            businessUnitCode: data.fiscal.businessUnitCode,
            tcrCode: data.fiscal.tcrCode,
            operatorCode: data.fiscal.operatorCode,
            cashierName: data.cashierName,
            softwareCode: data.fiscal.softwareCode,
            typeOfInvoice: data.fiscal.typeOfInvoice,
            qr: qrModules(data.fiscal.qrUrl),
          }
        : null,
    };

    const safeName = data.i.invoice_number.replace(/[^A-Za-z0-9._-]+/g, '-');
    return { bytes: renderInvoicePdf(pdf), fileName: `${safeName}.pdf` };
  }
}
