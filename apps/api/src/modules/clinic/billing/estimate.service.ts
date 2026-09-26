import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  isCurrency,
  vatCategoryOf,
  vatRateFor,
  vatSummary,
  type CurrencyCode,
} from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { StorageService } from '@/core/storage/storage.service';
import {
  calculateInvoice,
  calculateInvoiceLine,
  planLinesToInvoiceLines,
} from '@/modules/clinic/finance';
import { FxRatesService, convertMinor, type QuoteRate } from './fx-rates.service';

/** How long a printed estimate says its prices hold. */
const VALID_DAYS = 30;

/**
 * A treatment plan as a printable estimate: what the work will cost, with
 * TVSH worked out the way the invoice will work it out, and — for a patient
 * from abroad — the same figures in a second currency.
 *
 * The arithmetic is the invoice's own (planLinesToInvoiceLines and
 * calculateInvoiceLine, with the plan discount spread over the lines), so the
 * estimate and the invoice raised from the accepted plan agree to the cent.
 *
 * The second currency is converted per line and, separately, for the totals,
 * each rounded to the cent; the totals are not the sum of rounded lines, and
 * the estimate says the converted figures are indicative. Payment is taken in
 * the clinic's currency.
 */
@Injectable()
export class EstimateService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly storage: StorageService,
    private readonly fx: FxRatesService,
  ) {}

  async forPlan(planId: string, requested?: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    const result = await this.db.withTenant(tenantId, async (client) => {
      const { rows: planRows } = await client.query<{
        id: string;
        title: string;
        status: string;
        note: string | null;
        discount_amount: number;
        created_at: string;
        accepted_at: string | null;
        patient_id: string;
        first_name: string;
        last_name: string;
        phone: string | null;
        dob: string | null;
        dentist_name: string | null;
      }>(
        `SELECT tp.id, tp.title, tp.status, tp.note, tp.discount_amount, tp.created_at::text AS created_at,
                tp.accepted_at::text AS accepted_at, tp.patient_id,
                p.first_name, p.last_name, p.phone, p.birth_date::text AS dob,
                u.full_name AS dentist_name
           FROM treatment_plans tp
           JOIN patients p ON p.id = tp.patient_id
           LEFT JOIN users u ON u.id = tp.dentist_id
          WHERE tp.id = $1`,
        [planId],
      );
      const plan = planRows[0];
      if (!plan) throw new NotFoundException('Treatment plan not found');

      const { rows: items } = await client.query<{
        description: string;
        tooth: number | null;
        quantity: number;
        unit_fee: number;
        discount_amount: number;
        status: string;
        code: string | null;
        treatment_taxable: boolean | null;
        code_taxable: boolean | null;
      }>(
        `SELECT i.description, i.tooth, i.quantity, i.unit_fee, i.discount_amount, i.status,
                c.code, t.is_taxable AS treatment_taxable, c.is_taxable AS code_taxable
           FROM treatment_plan_items i
           LEFT JOIN treatments t ON t.id = i.treatment_id
           LEFT JOIN procedure_codes c ON c.id = i.procedure_code_id
          WHERE i.plan_id = $1 AND i.status <> 'cancelled'
          ORDER BY i.sort_order, i.created_at`,
        [planId],
      );

      const { rows: clinicRows } = await client.query<{
        name: string;
        legal_name: string | null;
        tax_number: string | null;
        address: string | null;
        city: string | null;
        phone: string | null;
        email: string | null;
        website: string | null;
        currency: string | null;
        vat_rate_bp: number | null;
        quote_currency: string | null;
        logo_storage_key: string | null;
        brand_color: string | null;
      }>(
        `SELECT t.name, cs.legal_name, cs.tax_number, cs.address, cs.city, cs.phone, cs.email,
                cs.website, cs.currency, cs.vat_rate_bp, cs.quote_currency, cs.logo_storage_key,
                cs.brand_color
           FROM tenants t LEFT JOIN clinic_settings cs ON cs.tenant_id = t.id
          WHERE t.id = $1`,
        [tenantId],
      );
      const clinic = clinicRows[0]!;
      const currency: CurrencyCode = isCurrency(clinic.currency)
        ? clinic.currency
        : 'EUR';
      const clinicRateBp = clinic.vat_rate_bp ?? 0;

      // The requested currency, the clinic's default quote currency, or none.
      const wanted = requested === 'none' ? null : (requested ?? clinic.quote_currency);
      if (wanted && !isCurrency(wanted))
        throw new BadRequestException(`"${wanted}" is not a supported currency`);
      const quoteCurrency =
        wanted && wanted !== currency ? (wanted as CurrencyCode) : null;
      const rate: QuoteRate | null = quoteCurrency
        ? await this.fx.rateFor(client, currency, quoteCurrency)
        : null;

      const lines = planLinesToInvoiceLines(
        items.map((i) => ({
          quantity: i.quantity,
          unitFee: i.unit_fee,
          discountAmount: i.discount_amount,
          taxRateBp: vatRateFor(
            vatCategoryOf(i.treatment_taxable || i.code_taxable),
            clinicRateBp,
          ),
        })),
        plan.discount_amount,
      );
      const totals = calculateInvoice(lines);
      const quote = (minor: number) => (rate ? convertMinor(minor, rate.rate) : null);

      const priced = items.map((item, idx) => {
        const cost = calculateInvoiceLine(lines[idx]!);
        return {
          description: item.description,
          code: item.code,
          tooth: item.tooth,
          status: item.status,
          quantity: lines[idx]!.quantity,
          unitPrice: lines[idx]!.unitPrice,
          discountAmount: cost.discountAmount,
          vatCategory: vatCategoryOf(item.treatment_taxable || item.code_taxable),
          taxRateBp: lines[idx]!.taxRateBp,
          net: cost.net,
          taxAmount: cost.taxAmount,
          total: cost.total,
          totalQuote: quote(cost.total),
        };
      });

      return { plan, clinic, currency, quoteCurrency, rate, priced, totals, quote };
    });

    const { plan, clinic, currency, quoteCurrency, rate, priced, totals, quote } = result;
    const logoUrl =
      clinic.logo_storage_key && this.storage.isConfigured
        ? await this.storage.signedViewUrl(clinic.logo_storage_key).catch(() => null)
        : null;
    const issued = new Date();
    const validUntil = new Date(issued.getTime() + VALID_DAYS * 24 * 60 * 60 * 1000);

    return {
      clinic: {
        name: clinic.name,
        legalName: clinic.legal_name,
        nipt: clinic.tax_number,
        address: clinic.address,
        city: clinic.city,
        phone: clinic.phone,
        email: clinic.email,
        website: clinic.website,
        brandColor: clinic.brand_color,
        logoUrl,
      },
      patient: {
        id: plan.patient_id,
        name: `${plan.first_name} ${plan.last_name}`,
        phone: plan.phone,
        dateOfBirth: plan.dob,
      },
      plan: {
        id: plan.id,
        title: plan.title,
        status: plan.status,
        note: plan.note,
        dentistName: plan.dentist_name,
        createdAt: plan.created_at,
        acceptedAt: plan.accepted_at,
      },
      issuedOn: issued.toISOString().slice(0, 10),
      validUntil: validUntil.toISOString().slice(0, 10),
      currency,
      quote:
        quoteCurrency && rate
          ? {
              currency: quoteCurrency,
              /** Clinic-currency units per ONE quote-currency unit. */
              rate: rate.rate,
              source: rate.source,
              provider: rate.provider,
              asOf: rate.asOf,
              stale: rate.stale,
            }
          : null,
      items: priced,
      vat: vatSummary(
        priced.map((i) => ({
          taxRateBp: i.taxRateBp,
          net: i.net,
          taxAmount: i.taxAmount,
        })),
      ),
      totals: {
        subtotal: totals.subtotal,
        discount: totals.discountAmount,
        net: totals.net,
        tax: totals.taxAmount,
        total: totals.total,
        netQuote: quote(totals.net),
        taxQuote: quote(totals.taxAmount),
        totalQuote: quote(totals.total),
      },
    };
  }
}
