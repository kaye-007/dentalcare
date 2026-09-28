import { WorkingDay } from './settings.types';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import {
  REMINDER_PLACEHOLDERS,
  isTimeZone,
  unknownPlaceholders,
} from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditService, ClinicAuditActor } from '@/core/audit/clinic-audit.service';
import { rethrowRecordLocked } from '@/core/audit/clinical-record';
import { StorageService } from '@/core/storage/storage.service';
import { detectFileType } from '@/core/storage/file-signature';
import { PaymentMethodDto, UpdateSettingsDto } from './dto/settings.dto';

export const DEFAULT_HOURS: WorkingDay[] = [
  { day: 0, closed: false, open: '09:00', close: '17:00' },
  { day: 1, closed: false, open: '09:00', close: '17:00' },
  { day: 2, closed: false, open: '09:00', close: '17:00' },
  { day: 3, closed: false, open: '09:00', close: '17:00' },
  { day: 4, closed: false, open: '09:00', close: '17:00' },
  { day: 5, closed: false, open: '09:00', close: '14:00' },
  { day: 6, closed: true, open: '09:00', close: '14:00' },
];

/**
 * The payment methods a clinic starts with. They are the three kinds the
 * ledger has always known, so an existing clinic's history reads the same.
 */
export const DEFAULT_PAYMENT_METHODS: PaymentMethodDto[] = [
  { id: 'cash', label: 'Cash', kind: 'cash', active: true },
  { id: 'card', label: 'Card', kind: 'card', active: true },
  { id: 'bank', label: 'Bank transfer', kind: 'bank', active: true },
];

/** A logo is printed on every invoice; it does not need to be a poster. */
const MAX_LOGO_BYTES = 1024 * 1024;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateHours(hours: WorkingDay[]) {
  if (hours.length !== 7)
    throw new BadRequestException('Working hours must cover all 7 days');
  for (const h of hours) {
    if (typeof h.day !== 'number' || h.day < 0 || h.day > 6) {
      throw new BadRequestException('Invalid day in working hours');
    }
    if (typeof h.closed !== 'boolean')
      throw new BadRequestException('Invalid closed flag');
    if (!h.closed) {
      if (!TIME_RE.test(h.open) || !TIME_RE.test(h.close)) {
        throw new BadRequestException('Times must be in HH:MM format');
      }
      if (h.close <= h.open) {
        throw new BadRequestException('Closing time must be after opening time');
      }
    }
  }
}

function validatePaymentMethods(methods: PaymentMethodDto[]) {
  const ids = new Set<string>();
  for (const m of methods) {
    if (ids.has(m.id))
      throw new BadRequestException(`Two payment methods share the id "${m.id}"`);
    ids.add(m.id);
  }
  if (!methods.some((m) => m.active)) {
    throw new BadRequestException('Keep at least one payment method active');
  }
}

/**
 * A clinic's own reminder wording, checked the way it will be used.
 *
 * Returns null to go back to the built-in message. An unknown placeholder is
 * refused rather than sent: "{reason}" would reach the patient as literal
 * braces, and the placeholder list is deliberately what keeps treatment
 * details off a lock screen.
 */
function reminderTemplate(input: string | null): string | null {
  const text = input?.trim() ?? '';
  if (text === '') return null;
  const unknown = unknownPlaceholders(text);
  if (unknown.length > 0) {
    throw new BadRequestException(
      `The reminder uses ${unknown.join(', ')}, which it cannot fill in. ` +
        `It can use ${REMINDER_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`,
    );
  }
  if (text.length < 20) {
    throw new BadRequestException('A reminder needs at least 20 characters');
  }
  return text;
}

/** An optional text field: undefined leaves it, null or blank clears it. */
const clearable = (v: string | null | undefined) =>
  v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim();

/** NIPT as the authority prints it: upper case, no spaces. */
function taxNumberOf(v: string | null | undefined): string | null | undefined {
  const value = clearable(v);
  return typeof value === 'string' ? value.toUpperCase().replace(/\s+/g, '') : value;
}

interface SettingsRow {
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  working_hours: unknown;
  default_appointment_duration: number;
  reminders_enabled: boolean;
  reminder_hours_before: number;
  reminder_channel: string;
  payroll_logging_enabled: boolean;
  mfa_required_for_all: boolean;
  currency: string;
  timezone: string;
  reminder_locale: string;
  reminder_template: string | null;
  phone_country_code: string;
  legal_name: string | null;
  registration_number: string | null;
  tax_number: string | null;
  website: string | null;
  brand_color: string | null;
  logo_storage_key: string | null;
  logo_updated_at: string | null;
  invoice_prefix: string;
  vat_rate_bp: number;
  payment_terms_days: number;
  payment_methods: unknown;
  quote_currency: string | null;
  fx_rate_source: string;
  fx_fixed_rate: string | null;
  default_checkout_mode: string;
  internal_receipts_enabled: boolean;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
    private readonly storage: StorageService,
  ) {}

  async get() {
    const tenantId = this.tenant.getRequiredTenantId();
    const { name, row } = await this.db.withTenant(tenantId, async (client) => {
      const t = await client.query<{ name: string }>(
        'SELECT name FROM tenants WHERE id = $1',
        [tenantId],
      );
      const s = await client.query<SettingsRow>(
        `SELECT address, city, phone, email, working_hours, default_appointment_duration,
                reminders_enabled, reminder_hours_before, reminder_channel,
                payroll_logging_enabled, mfa_required_for_all, currency, timezone,
                reminder_locale, reminder_template, phone_country_code,
                legal_name, registration_number, tax_number, website, brand_color,
                logo_storage_key, logo_updated_at, invoice_prefix, vat_rate_bp,
                payment_terms_days, payment_methods,
                quote_currency, fx_rate_source, fx_fixed_rate,
                default_checkout_mode, internal_receipts_enabled
           FROM clinic_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      return { name: t.rows[0]?.name ?? '', row: s.rows[0] };
    });

    // A short-lived link, minted after the transaction: it is a signature, not
    // a database read, and holding a connection for it buys nothing.
    let logoUrl: string | null = null;
    if (row?.logo_storage_key && this.storage.isConfigured) {
      logoUrl = await this.storage.signedViewUrl(row.logo_storage_key).catch(() => null);
    }

    const methods =
      Array.isArray(row?.payment_methods) && row.payment_methods.length > 0
        ? (row.payment_methods as PaymentMethodDto[])
        : DEFAULT_PAYMENT_METHODS;

    return {
      clinicName: name,
      address: row?.address ?? '',
      city: row?.city ?? '',
      phone: row?.phone ?? '',
      email: row?.email ?? '',
      workingHours:
        row && Array.isArray(row.working_hours) && row.working_hours.length === 7
          ? (row.working_hours as WorkingDay[])
          : DEFAULT_HOURS,
      defaultAppointmentDuration: row?.default_appointment_duration ?? 45,
      remindersEnabled: row?.reminders_enabled ?? false,
      reminderHoursBefore: row?.reminder_hours_before ?? 24,
      reminderChannel: row?.reminder_channel ?? 'sms',
      payrollLoggingEnabled: row?.payroll_logging_enabled ?? true,
      mfaRequiredForAll: row?.mfa_required_for_all ?? false,
      currency: row?.currency ?? 'EUR',
      timezone: row?.timezone ?? 'Europe/Tirane',
      reminderLocale: row?.reminder_locale ?? 'en',
      reminderTemplate: row?.reminder_template ?? null,
      phoneCountryCode: row?.phone_country_code ?? '355',
      legalName: row?.legal_name ?? null,
      registrationNumber: row?.registration_number ?? null,
      taxNumber: row?.tax_number ?? null,
      website: row?.website ?? null,
      brandColor: row?.brand_color ?? null,
      logoUrl,
      logoUpdatedAt: row?.logo_updated_at ?? null,
      invoicePrefix: row?.invoice_prefix ?? 'INV-',
      vatRateBp: row?.vat_rate_bp ?? 0,
      paymentTermsDays: row?.payment_terms_days ?? 0,
      paymentMethods: methods,
      quoteCurrency: row?.quote_currency ?? null,
      fxRateSource: row?.fx_rate_source === 'fixed' ? 'fixed' : 'live',
      fxFixedRate: row?.fx_fixed_rate != null ? Number(row.fx_fixed_rate) : null,
      /** What the payment screen preselects: fiscal, internal, or neither. */
      defaultCheckoutMode: (row?.default_checkout_mode ?? 'fiscal') as
        'internal' | 'fiscal' | 'ask',
      internalReceiptsEnabled: row?.internal_receipts_enabled ?? true,
    };
  }

  async update(dto: UpdateSettingsDto, actor: ClinicAuditActor) {
    if (dto.workingHours) validateHours(dto.workingHours);
    if (dto.paymentMethods) validatePaymentMethods(dto.paymentMethods);
    if (dto.timezone !== undefined && !isTimeZone(dto.timezone)) {
      throw new BadRequestException(
        `"${dto.timezone}" is not a time zone. Use a name such as Europe/Tirane.`,
      );
    }
    // undefined: leave alone. null: back to the built-in message.
    const template =
      dto.reminderTemplate === undefined
        ? undefined
        : reminderTemplate(dto.reminderTemplate);
    if (dto.fxRateSource === 'fixed' && dto.fxFixedRate === null) {
      throw new BadRequestException('A fixed exchange rate needs the rate itself.');
    }

    const columns: [string, unknown][] = [
      ['address', dto.address],
      ['city', dto.city],
      ['phone', dto.phone],
      ['email', dto.email],
      ['working_hours', dto.workingHours ? JSON.stringify(dto.workingHours) : undefined],
      ['default_appointment_duration', dto.defaultAppointmentDuration],
      ['reminders_enabled', dto.remindersEnabled],
      ['reminder_hours_before', dto.reminderHoursBefore],
      ['reminder_channel', dto.reminderChannel],
      ['payroll_logging_enabled', dto.payrollLoggingEnabled],
      ['mfa_required_for_all', dto.mfaRequiredForAll],
      ['currency', dto.currency],
      ['timezone', dto.timezone],
      ['reminder_locale', dto.reminderLocale],
      ['reminder_template', template],
      ['phone_country_code', dto.phoneCountryCode],
      ['legal_name', clearable(dto.legalName)],
      ['registration_number', clearable(dto.registrationNumber)],
      ['tax_number', taxNumberOf(dto.taxNumber)],
      ['website', clearable(dto.website)],
      [
        'brand_color',
        dto.brandColor === undefined
          ? undefined
          : (dto.brandColor?.toLowerCase() ?? null),
      ],
      ['invoice_prefix', dto.invoicePrefix],
      ['vat_rate_bp', dto.vatRateBp],
      ['payment_terms_days', dto.paymentTermsDays],
      [
        'payment_methods',
        dto.paymentMethods ? JSON.stringify(dto.paymentMethods) : undefined,
      ],
      ['fx_rate_source', dto.fxRateSource],
      ['fx_fixed_rate', dto.fxFixedRate],
      ['default_checkout_mode', dto.defaultCheckoutMode],
      ['internal_receipts_enabled', dto.internalReceiptsEnabled],
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of columns) {
      if (value === undefined) continue;
      params.push(value);
      const cast =
        column === 'working_hours' || column === 'payment_methods' ? '::jsonb' : '';
      sets.push(`${column} = $${params.length}${cast}`);
    }

    const tenantId = this.tenant.getRequiredTenantId();
    await this.db.withTenant(tenantId, async (client) => {
      if (dto.clinicName !== undefined) {
        await client.query(
          'UPDATE tenants SET name = $1, updated_at = now() WHERE id = $2',
          [dto.clinicName, tenantId],
        );
      }
      // Every column has a default, so a clinic that has never saved settings
      // gets a row of defaults first and the update below changes only what
      // was sent.
      await client.query(
        'INSERT INTO clinic_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING',
        [tenantId],
      );
      // The quote currency can never equal the clinic's own; a change of either
      // that would make them equal drops the quote rather than failing.
      if (dto.quoteCurrency !== undefined || dto.currency !== undefined) {
        const { rows: cur } = await client.query<{
          currency: string;
          quote_currency: string | null;
        }>('SELECT currency, quote_currency FROM clinic_settings WHERE tenant_id = $1', [
          tenantId,
        ]);
        const own = dto.currency ?? cur[0]?.currency;
        const quote =
          dto.quoteCurrency !== undefined
            ? dto.quoteCurrency
            : (cur[0]?.quote_currency ?? null);
        if (dto.quoteCurrency !== undefined && quote !== null && quote === own) {
          throw new BadRequestException(
            'The estimate currency must differ from the clinic currency.',
          );
        }
        params.push(quote === own ? null : quote);
        sets.push(`quote_currency = $${params.length}`);
      }
      if (sets.length > 0) {
        params.push(tenantId);
        await client
          .query(
            `UPDATE clinic_settings SET ${sets.join(', ')}, updated_at = now()
              WHERE tenant_id = $${params.length}`,
            params,
          )
          // A currency change after money exists is refused by a trigger with
          // a message written for a person; pass it through as a 409.
          .catch(rethrowRecordLocked);
      }

      // Clinic configuration reaches billing (currency, VAT), payroll
      // visibility and what patients are sent, so a change here is worth as
      // much as a money entry. Which fields, never their values.
      const fields = Object.entries(dto)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);
      await this.audit.record(client, actor, {
        action: 'settings.updated',
        entityType: 'clinic_settings',
        entityId: tenantId,
        summary: `Changed clinic settings (${fields.join(', ') || 'no fields'})`,
        metadata: { fields },
      });
    });
    return this.get();
  }

  /**
   * Replace the clinic logo.
   *
   * JPEG only, and small. The clinic app re-encodes whatever was picked onto a
   * white background before sending it, because the logo's real destination is
   * the invoice PDF, which embeds JPEG as-is and would need a PNG decoder —
   * transparency, filters, interlacing — to do anything else.
   */
  async uploadLogo(file: Express.Multer.File | undefined, actor: ClinicAuditActor) {
    if (!this.storage.isConfigured) {
      throw new ServiceUnavailableException(
        'File storage is not configured on this server.',
      );
    }
    if (!file?.buffer?.length) throw new BadRequestException('No file was uploaded');
    if (file.size > MAX_LOGO_BYTES)
      throw new BadRequestException('A logo must be under 1 MB');
    if (detectFileType(file.buffer) !== 'image/jpeg') {
      throw new BadRequestException('The logo must be a JPEG image');
    }

    const tenantId = this.tenant.getRequiredTenantId();
    const key = this.storage.buildBrandingKey(tenantId, 'jpg');
    await this.storage.put(key, file.buffer, 'image/jpeg', {
      tenant: tenantId,
      purpose: 'logo',
    });

    let previous: string | null = null;
    try {
      previous = await this.db.withTenant(tenantId, async (client) => {
        await client.query(
          'INSERT INTO clinic_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING',
          [tenantId],
        );
        const old = await this.swapLogo(client, tenantId, key);
        await this.audit.record(client, actor, {
          action: 'settings.logo_changed',
          entityType: 'clinic_settings',
          entityId: tenantId,
          summary: 'Uploaded a new clinic logo',
        });
        return old;
      });
    } catch (err) {
      await this.storage.remove(key);
      throw err;
    }
    // The old object goes only once the row no longer points at it.
    if (previous) await this.storage.remove(previous);
    return this.get();
  }

  async removeLogo(actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    const previous = await this.db.withTenant(tenantId, async (client) => {
      const old = await this.swapLogo(client, tenantId, null);
      if (!old) throw new NotFoundException('The clinic has no logo');
      await this.audit.record(client, actor, {
        action: 'settings.logo_changed',
        entityType: 'clinic_settings',
        entityId: tenantId,
        summary: 'Removed the clinic logo',
      });
      return old;
    });
    await this.storage.remove(previous);
    return this.get();
  }

  private async swapLogo(client: PoolClient, tenantId: string, key: string | null) {
    const { rows } = await client.query<{ logo_storage_key: string | null }>(
      'SELECT logo_storage_key FROM clinic_settings WHERE tenant_id = $1 FOR UPDATE',
      [tenantId],
    );
    await client.query(
      `UPDATE clinic_settings
          SET logo_storage_key = $1,
              logo_updated_at = CASE WHEN $1::text IS NULL THEN NULL ELSE now() END,
              updated_at = now()
        WHERE tenant_id = $2`,
      [key, tenantId],
    );
    return rows[0]?.logo_storage_key ?? null;
  }
}
