import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { clinicCurrency } from '@/core/money/clinic-currency';
import { vatSummary } from '@dentalcare/shared';
import { Keyring, developmentKeyring, open, parseKeyring, seal } from '@/core/mfa/secret-box';
import { FiscalCertificateError, describeSubject, importSigningKey, parseSigningMaterial } from './fiscal-crypto';
import { pkcs12ToPem } from './fiscal-pkcs12';
import { queueTiming } from './fiscal-queue';
import {
  FiscalValidationError,
  computeIic,
  fiscalTotals,
  invNum,
  issueDateTime,
  newHeader,
  parseCisResponse,
  registerCashDepositXml,
  registerInvoiceXml,
  signRequest,
  soapEnvelope,
  verificationUrl,
  type FiscalInvoiceInput,
  type FiscalPayType,
  type RequestHeader,
} from './fiscal-xml';
import { CashDepositDto, InstallCertificateDto, UpdateFiscalSettingsDto } from './dto/fiscal.dto';

/** An Albanian NIPT: a letter, eight digits, a letter. */
const NIPT = /^[A-Z][0-9]{8}[A-Z]$/;

/** The zone every fiscal time is written in. Albania has one. */
const FISCAL_TZ = 'Europe/Tirane';

/**
 * SOAPAction values. Taken from the service description as published; the
 * test environment is where these are confirmed before production use.
 */
const SOAP_ACTION = {
  invoice: 'https://eFiskalizimi.tatime.gov.al/FiscalizationService/RegisterInvoice',
  cash: 'https://eFiskalizimi.tatime.gov.al/FiscalizationService/RegisterCashDeposit',
};

const CIS_TIMEOUT_MS = 15_000;

interface SettingsRow {
  enabled: boolean;
  environment: 'test' | 'production';
  business_unit_code: string | null;
  tcr_code: string | null;
  is_issuer_in_vat: boolean;
  vat_exemption_code: string;
  certificate_pem: string | null;
  certificate_subject: string | null;
  certificate_not_after: string | null;
  private_key_ciphertext: string | null;
  private_key_key_id: string | null;
}

interface FiscalRow {
  id: string;
  invoice_id: string;
  status: 'pending' | 'fiscalized' | 'rejected';
  environment: 'test' | 'production';
  type_of_invoice: 'CASH' | 'NONCASH';
  business_unit_code: string;
  tcr_code: string;
  operator_code: string;
  software_code: string;
  inv_ord_num: number;
  inv_num: string;
  issue_datetime: string;
  total_price: number;
  iic: string;
  iic_signature: string;
  fic: string | null;
  qr_url: string;
  payload: FiscalInvoiceInput;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  fiscalized_at: string | null;
  last_error: string | null;
  last_error_code: string | null;
  created_at: string;
}

export function mapFiscal(r: FiscalRow) {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    status: r.status,
    environment: r.environment,
    typeOfInvoice: r.type_of_invoice,
    businessUnitCode: r.business_unit_code,
    tcrCode: r.tcr_code,
    operatorCode: r.operator_code,
    softwareCode: r.software_code,
    invOrdNum: r.inv_ord_num,
    invNum: r.inv_num,
    issueDateTime: r.issue_datetime,
    /** Issuer Security Code (IIC). Valid from the moment it is signed. */
    nslf: r.iic,
    /** Fiscal Identification Code (FIC). Only once the authority has acknowledged it. */
    nivf: r.fic,
    qrUrl: r.qr_url,
    attempts: r.attempts,
    lastAttemptAt: r.last_attempt_at,
    nextAttemptAt: r.next_attempt_at,
    fiscalizedAt: r.fiscalized_at,
    lastError: r.last_error,
    lastErrorCode: r.last_error_code,
    createdAt: r.created_at,
  };
}
export type FiscalRecord = ReturnType<typeof mapFiscal>;

const PAY_TYPE: Readonly<Record<string, FiscalPayType>> = {
  cash: 'BANKNOTE',
  card: 'CARD',
  bank: 'ACCOUNT',
};

/** Minutes to wait before the next delivery attempt: 1, 2, 4 … capped at an hour. */
function backoffMinutes(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

/**
 * Albanian fiscalization for one clinic.
 *
 * ── The shape of one fiscal invoice ───────────────────────────────────────
 *
 *   register   In ONE transaction: lock the invoice, take the next order
 *              number for the register, compute and sign the NSLF, and store
 *              it all as 'pending'. Once this commits the invoice IS issued:
 *              its NSLF and QR are valid and can be printed, whether or not
 *              the authority has answered yet.
 *   deliver    OUTSIDE any transaction — a network call to the authority.
 *   settle     'fiscalized' with the NIVF, 'rejected' with the fault, or left
 *              'pending' with a retry time when the authority could not be
 *              reached. A retry is sent as a subsequent delivery, as the law
 *              allows for invoices issued while offline.
 *
 * Registering the same invoice twice returns the existing registration: the
 * unique index on invoice_id makes a second NSLF for one invoice impossible.
 */
@Injectable()
export class FiscalService {
  private readonly logger = new Logger(FiscalService.name);
  private readonly keyring: Keyring;

  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
    private readonly config: ConfigService,
  ) {
    const spec = config.get<string>('MFA_ENCRYPTION_KEYS');
    // The same envelope as MFA secrets; env.validation refuses production
    // without real keys, so the derived key is development only.
    this.keyring = spec ? parseKeyring(spec) : developmentKeyring(config.get<string>('JWT_SECRET')!);
  }

  private softwareCode(): string | null {
    return this.config.get<string>('FISCAL_SOFTWARE_CODE')?.trim() || null;
  }

  private cisUrl(env: 'test' | 'production'): string {
    return this.config.get<string>(env === 'production' ? 'FISCAL_CIS_URL_PRODUCTION' : 'FISCAL_CIS_URL_TEST')!;
  }

  private verifyBase(env: 'test' | 'production'): string {
    return this.config.get<string>(env === 'production' ? 'FISCAL_VERIFY_URL_PRODUCTION' : 'FISCAL_VERIFY_URL_TEST')!;
  }

  private aad(tenantId: string) {
    return `clinic_fiscal_settings:${tenantId}`;
  }

  /* ── settings ─────────────────────────────────────────────────────── */

  async getSettings() {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const s = await this.settingsRow(client);
      const clinic = await this.clinicRow(client, tenantId);
      const { rows: operators } = await client.query<{
        id: string; full_name: string; role: string; fiscal_operator_code: string | null;
      }>(
        `SELECT id, full_name, role, fiscal_operator_code FROM users
          WHERE status = 'active' AND role IN ('admin','receptionist')
          ORDER BY full_name`,
      );
      return {
        /** The deployment has a software code; without one nothing can be registered. */
        available: this.softwareCode() !== null,
        enabled: s?.enabled ?? false,
        environment: s?.environment ?? 'test',
        businessUnitCode: s?.business_unit_code ?? null,
        tcrCode: s?.tcr_code ?? null,
        isIssuerInVat: s?.is_issuer_in_vat ?? false,
        vatExemptionCode: s?.vat_exemption_code ?? 'TYPE_1',
        certificate: s?.certificate_pem
          ? { subject: s.certificate_subject, notAfter: s.certificate_not_after }
          : null,
        seller: {
          nipt: clinic.nipt,
          niptValid: clinic.nipt !== null && NIPT.test(clinic.nipt),
          name: clinic.name,
          address: clinic.address,
          town: clinic.town,
          currency: clinic.currency,
        },
        operators: operators.map((o) => ({
          userId: o.id,
          fullName: o.full_name,
          role: o.role,
          operatorCode: o.fiscal_operator_code,
        })),
      };
    });
  }

  async updateSettings(dto: UpdateFiscalSettingsDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    await this.db.withTenant(tenantId, async (client) => {
      await client.query(
        'INSERT INTO clinic_fiscal_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING',
        [tenantId],
      );
      const current = (await this.settingsRow(client))!;
      const next = {
        enabled: dto.enabled ?? current.enabled,
        environment: dto.environment ?? current.environment,
        business_unit_code: dto.businessUnitCode !== undefined ? dto.businessUnitCode : current.business_unit_code,
        tcr_code: dto.tcrCode !== undefined ? dto.tcrCode : current.tcr_code,
        is_issuer_in_vat: dto.isIssuerInVat ?? current.is_issuer_in_vat,
        vat_exemption_code: dto.vatExemptionCode ?? current.vat_exemption_code,
      };

      if (next.enabled) {
        const clinic = await this.clinicRow(client, tenantId);
        const missing: string[] = [];
        if (!this.softwareCode()) missing.push('the software code for this deployment (NODE X support)');
        if (!clinic.nipt || !NIPT.test(clinic.nipt)) missing.push('the clinic NIPT (Settings → Clinic profile)');
        if (!clinic.address || !clinic.town) missing.push('the clinic address and city');
        if (!next.business_unit_code) missing.push('the business unit code');
        if (!next.tcr_code) missing.push('the cash register (TCR) code');
        if (!current.private_key_ciphertext) missing.push('the signing certificate');
        if (clinic.currency !== 'ALL') missing.push('lek (ALL) as the clinic currency');
        if (missing.length) {
          throw new BadRequestException(`Fiscalization cannot be turned on without ${missing.join(', ')}.`);
        }
      }

      await client.query(
        `UPDATE clinic_fiscal_settings
            SET enabled = $2, environment = $3, business_unit_code = $4, tcr_code = $5,
                is_issuer_in_vat = $6, vat_exemption_code = $7, updated_by = $8, updated_at = now()
          WHERE tenant_id = $1`,
        [tenantId, next.enabled, next.environment, next.business_unit_code, next.tcr_code,
         next.is_issuer_in_vat, next.vat_exemption_code, actor.userId],
      );
      const fields = Object.entries(dto).filter(([, v]) => v !== undefined).map(([k]) => k);
      await this.audit.record(client, actor, {
        action: 'fiscal.settings_updated',
        entityType: 'clinic_fiscal_settings',
        entityId: tenantId,
        summary: `Changed fiscalization settings (${fields.join(', ') || 'no fields'})`,
        metadata: { fields, enabled: next.enabled, environment: next.environment },
      });
    });
    return this.getSettings();
  }

  async installCertificate(dto: InstallCertificateDto, actor: ClinicAuditActor) {
    let material;
    try {
      const pem =
        dto.p12Base64 !== undefined
          ? await pkcs12ToPem(Buffer.from(dto.p12Base64, 'base64'), dto.password ?? '')
          : dto.pem;
      if (!pem) throw new FiscalCertificateError('Upload the certificate file.');
      material = await parseSigningMaterial(pem);
    } catch (err) {
      if (err instanceof FiscalCertificateError) throw new BadRequestException(err.message);
      throw err;
    }
    const tenantId = this.tenant.getRequiredTenantId();
    const sealed = seal(this.keyring, material.pkcs8.toString('base64'), this.aad(tenantId));
    const subject = describeSubject(material.info.subject);

    await this.db.withTenant(tenantId, async (client) => {
      await client.query(
        'INSERT INTO clinic_fiscal_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING',
        [tenantId],
      );
      await client.query(
        `UPDATE clinic_fiscal_settings
            SET certificate_pem = $2, certificate_subject = $3, certificate_not_after = $4,
                private_key_ciphertext = $5, private_key_key_id = $6,
                updated_by = $7, updated_at = now()
          WHERE tenant_id = $1`,
        [tenantId, material.certificatePem, subject, material.info.notAfter,
         sealed.ciphertext, sealed.keyId, actor.userId],
      );
      await this.audit.record(client, actor, {
        action: 'fiscal.certificate_installed',
        entityType: 'clinic_fiscal_settings',
        entityId: tenantId,
        summary: `Installed the signing certificate for ${subject}, valid until ${material.info.notAfter.toISOString().slice(0, 10)}`,
        metadata: {
          subject,
          notAfter: material.info.notAfter.toISOString(),
          format: dto.p12Base64 !== undefined ? 'pkcs12' : 'pem',
        },
      });
    });
    return this.getSettings();
  }

  async setOperatorCode(userId: string, code: string | null, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    await this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ full_name: string }>(
        'UPDATE users SET fiscal_operator_code = $2, updated_at = now() WHERE id = $1 RETURNING full_name',
        [userId, code],
      );
      if (!rows[0]) throw new NotFoundException('Staff member not found');
      await this.audit.record(client, actor, {
        action: 'fiscal.settings_updated',
        entityType: 'user',
        entityId: userId,
        summary: code
          ? `Set ${rows[0].full_name}'s fiscal operator code`
          : `Removed ${rows[0].full_name}'s fiscal operator code`,
        metadata: { operatorCode: code },
      });
    });
    return this.getSettings();
  }

  /* ── invoices ─────────────────────────────────────────────────────── */

  async forInvoice(invoiceId: string): Promise<FiscalRecord | null> {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), (client) =>
      fiscalRecordFor(client, invoiceId),
    );
  }

  async fiscalize(invoiceId: string, actor: ClinicAuditActor): Promise<FiscalRecord> {
    const tenantId = this.tenant.getRequiredTenantId();
    const software = this.softwareCode();
    if (!software) {
      throw new ServiceUnavailableException('Fiscalization is not available on this deployment.');
    }

    const registered = await this.db.withTenant(tenantId, async (client) => {
      const { rows: inv } = await client.query<{
        status: string; total: number; issued_at: string; invoice_number: string;
      }>(
        'SELECT status, total, issued_at::text AS issued_at, invoice_number FROM invoices WHERE id = $1 FOR UPDATE',
        [invoiceId],
      );
      const invoice = inv[0];
      if (!invoice) throw new NotFoundException('Invoice not found');

      const existing = await fiscalRecordFor(client, invoiceId);
      if (existing) return { record: existing, isNew: false };
      if (invoice.status === 'cancelled') throw new ConflictException('A cancelled invoice cannot be fiscalized');

      const settings = await this.settingsRow(client);
      if (!settings?.enabled || !settings.business_unit_code || !settings.tcr_code || !settings.private_key_ciphertext) {
        throw new BadRequestException('Fiscalization is not turned on for this clinic (Settings → Fiscalization).');
      }
      const clinic = await this.clinicRow(client, tenantId);
      if (!clinic.nipt || !NIPT.test(clinic.nipt)) {
        throw new BadRequestException('The clinic NIPT is missing or not in the form L12345678A.');
      }
      if ((await clinicCurrency(client)) !== 'ALL') {
        throw new BadRequestException('Only invoices in lek (ALL) can be fiscalized.');
      }

      const { rows: op } = await client.query<{ fiscal_operator_code: string | null }>(
        'SELECT fiscal_operator_code FROM users WHERE id = $1',
        [actor.userId],
      );
      const operatorCode = op[0]?.fiscal_operator_code;
      if (!operatorCode) {
        throw new BadRequestException(
          'Your account has no fiscal operator code. An administrator sets it in Settings → Fiscalization.',
        );
      }

      const payment = await this.paymentFor(client, invoiceId, invoice.total, invoice.status);
      const items = await this.itemsFor(client, invoiceId);

      const now = new Date();
      const year = Number(issueDateTime(now, FISCAL_TZ).slice(0, 4));
      await client.query(
        `INSERT INTO fiscal_counters (tenant_id, tcr_code, year) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, tcr_code, year) DO NOTHING`,
        [tenantId, settings.tcr_code, year],
      );
      const { rows: counter } = await client.query<{ last_number: number }>(
        `SELECT last_number FROM fiscal_counters
          WHERE tenant_id = $1 AND tcr_code = $2 AND year = $3 FOR UPDATE`,
        [tenantId, settings.tcr_code, year],
      );
      const ordNum = counter[0]!.last_number + 1;
      await client.query(
        'UPDATE fiscal_counters SET last_number = $4 WHERE tenant_id = $1 AND tcr_code = $2 AND year = $3',
        [tenantId, settings.tcr_code, year, ordNum],
      );

      const input: FiscalInvoiceInput = {
        nipt: clinic.nipt,
        seller: { name: clinic.name, address: clinic.address!, town: clinic.town! },
        businessUnitCode: settings.business_unit_code,
        tcrCode: settings.tcr_code,
        operatorCode,
        softwareCode: software,
        invOrdNum: ordNum,
        year,
        issueDateTime: issueDateTime(now, FISCAL_TZ),
        typeOfInv: payment.type,
        isIssuerInVat: settings.is_issuer_in_vat,
        vatExemptionCode: settings.vat_exemption_code,
        payMethods: payment.methods,
        items,
        totalPrice: invoice.total,
      };
      try {
        fiscalTotals(input);
      } catch (err) {
        if (err instanceof FiscalValidationError) throw new BadRequestException(err.message);
        throw err;
      }

      const key = await this.signingKey(settings, tenantId);
      const codes = await computeIic(key, input);
      const qr = verificationUrl(this.verifyBase(settings.environment), input, codes.iic);

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO fiscal_invoices
           (tenant_id, invoice_id, status, environment, type_of_invoice, business_unit_code,
            tcr_code, operator_code, software_code, inv_ord_num, inv_num, issue_datetime,
            total_price, iic, iic_signature, qr_url, payload, next_attempt_at, created_by)
         VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb, now(), $17)
         RETURNING id`,
        [tenantId, invoiceId, settings.environment, input.typeOfInv, input.businessUnitCode,
         input.tcrCode, operatorCode, software, ordNum, invNum(input), input.issueDateTime,
         input.totalPrice, codes.iic, codes.iicSignature, qr, JSON.stringify(input), actor.userId],
      );
      await this.audit.record(client, actor, {
        action: 'fiscal.invoice_registered',
        entityType: 'invoice',
        entityId: invoiceId,
        summary: `Issued ${invoice.invoice_number} as fiscal invoice ${invNum(input)}`,
        metadata: { fiscalInvoiceId: rows[0]!.id, invNum: invNum(input), environment: settings.environment },
      });
      return { record: (await fiscalRecordFor(client, invoiceId))!, isNew: true };
    });

    if (registered.record.status !== 'pending') return registered.record;
    await this.deliver(tenantId, registered.record.id);
    return (await this.forInvoice(invoiceId))!;
  }

  /**
   * What a fiscal receipt prints, read from what was SIGNED — the payload
   * stored when the NSLF was computed — rather than from the invoice as it
   * stands. The two are the same by construction (a registered invoice can be
   * neither cancelled nor have its payments voided), but the receipt is a
   * statement about the registration, so it is built from the registration.
   */
  async receipt(invoiceId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<FiscalRow & {
        invoice_number: string; patient_name: string; cashier_name: string | null;
      }>(
        `SELECT f.*, i.invoice_number, (p.first_name || ' ' || p.last_name) AS patient_name,
                u.full_name AS cashier_name
           FROM fiscal_invoices f
           JOIN invoices i ON i.id = f.invoice_id
           JOIN patients p ON p.id = i.patient_id
           LEFT JOIN users u ON u.id = f.created_by
          WHERE f.invoice_id = $1`,
        [invoiceId],
      );
      const r = rows[0];
      if (!r) throw new NotFoundException('This invoice has not been fiscalized');
      const { rows: contact } = await client.query<{ phone: string | null; email: string | null }>(
        'SELECT phone, email FROM clinic_settings LIMIT 1',
      );
      const p = r.payload;
      const items = p.items.map((item) => ({
        name: item.name,
        code: item.code ?? null,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount,
        taxRateBp: item.taxRateBp,
        taxAmount: item.taxAmount,
        total: item.total,
      }));
      const totals = fiscalTotals(p);
      return {
        environment: r.environment,
        status: r.status,
        seller: {
          name: p.seller.name,
          nipt: p.nipt,
          address: p.seller.address,
          town: p.seller.town,
          phone: contact[0]?.phone ?? null,
          email: contact[0]?.email ?? null,
        },
        invoiceNumber: r.invoice_number,
        buyerName: r.patient_name,
        fiscal: mapFiscal(r),
        cashier: { name: r.cashier_name, operatorCode: r.operator_code },
        isIssuerInVat: p.isIssuerInVat,
        vatExemptionCode: p.vatExemptionCode,
        currency: 'ALL' as const,
        items,
        vat: vatSummary(items.map((i) => ({ taxRateBp: i.taxRateBp, net: i.total - i.taxAmount, taxAmount: i.taxAmount }))),
        totals: { net: totals.priceWoVat, vat: totals.vat, total: totals.price },
        payments: p.payMethods,
      };
    });
  }

  /** Deliver every registered invoice whose retry time has come. For the scheduler. */
  async deliverDue(tenantId: string): Promise<number> {
    const { rows } = await this.db.withTenant(tenantId, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM fiscal_invoices
          WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY created_at LIMIT 50`,
      ),
    );
    for (const { id } of rows) await this.deliver(tenantId, id);
    return rows.length;
  }

  /** Sign and send one registration, then record what the authority said. */
  async deliver(tenantId: string, fiscalId: string): Promise<void> {
    const leased = await this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<FiscalRow>(
        `UPDATE fiscal_invoices
            SET attempts = attempts + 1, last_attempt_at = now(),
                next_attempt_at = now() + interval '10 minutes', updated_at = now()
          WHERE id = $1 AND status = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          RETURNING *`,
        [fiscalId],
      );
      const row = rows[0];
      if (!row) return null;
      const settings = await this.settingsRow(client);
      return { row, settings };
    });
    if (!leased?.settings?.private_key_ciphertext || !leased.settings.certificate_pem) return;
    const { row, settings } = leased;

    let envelope: string;
    try {
      const key = await this.signingKey(settings, tenantId);
      // The first attempt is a normal delivery. Anything later was issued while
      // the authority could not be reached, which is what the flag declares.
      const header: RequestHeader = newHeader(FISCAL_TZ, row.attempts > 1 ? 'NOINTERNET' : undefined);
      const unsigned = registerInvoiceXml(row.payload, header, { iic: row.iic, iicSignature: row.iic_signature });
      envelope = soapEnvelope(await signRequest(unsigned, key, certificateDer(settings.certificate_pem!)));
    } catch (err) {
      await this.settle(tenantId, fiscalId, {
        status: 'rejected',
        error: `Could not sign the invoice: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const answer = await this.post(this.cisUrl(row.environment), SOAP_ACTION.invoice, envelope, 'FIC');
    if (answer.kind === 'code') {
      await this.settle(tenantId, fiscalId, { status: 'fiscalized', fic: answer.code, request: envelope, response: answer.body });
    } else if (answer.kind === 'fault') {
      await this.settle(tenantId, fiscalId, {
        status: 'rejected', error: answer.message, errorCode: answer.code, request: envelope, response: answer.body,
      });
    } else {
      await this.settle(tenantId, fiscalId, {
        status: 'pending',
        error: answer.message,
        retryInMinutes: backoffMinutes(row.attempts),
        request: envelope,
        response: answer.body,
      });
    }
  }

  /**
   * What has not reached the tax authority: still waiting, or refused.
   *
   * The desk that issued them, the accountant who reconciles them and the
   * administrator all read this. It carries the invoice and patient so a
   * person can act on a line without opening five screens, and the timing
   * against the 48-hour window so the urgent ones are obvious.
   */
  queue() {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), async (client) => {
      const { rows } = await client.query<{
        id: string;
        invoice_id: string;
        invoice_number: string;
        patient_name: string;
        status: 'pending' | 'rejected';
        total_price: number;
        issue_datetime: string;
        iic: string;
        attempts: number;
        next_attempt_at: string | null;
        last_attempt_at: string | null;
        last_error: string | null;
        last_error_code: string | null;
        environment: string;
      }>(
        `SELECT f.id, f.invoice_id, i.invoice_number,
                (p.first_name || ' ' || p.last_name) AS patient_name,
                f.status, f.total_price, f.issue_datetime, f.iic, f.attempts,
                f.next_attempt_at, f.last_attempt_at, f.last_error, f.last_error_code, f.environment
           FROM fiscal_invoices f
           JOIN invoices i ON i.id = f.invoice_id
           JOIN patients p ON p.id = i.patient_id
          WHERE f.status <> 'fiscalized'
          ORDER BY f.issue_datetime`,
      );

      const items = rows.map((r) => ({
        id: r.id,
        invoiceId: r.invoice_id,
        invoiceNumber: r.invoice_number,
        patientName: r.patient_name,
        status: r.status,
        environment: r.environment,
        total: r.total_price,
        issueDateTime: r.issue_datetime,
        nslf: r.iic,
        attempts: r.attempts,
        nextAttemptAt: r.next_attempt_at,
        lastAttemptAt: r.last_attempt_at,
        lastError: r.last_error,
        lastErrorCode: r.last_error_code,
        ...queueTiming(r.issue_datetime),
      }));

      return {
        items,
        counts: {
          pending: items.filter((i) => i.status === 'pending').length,
          rejected: items.filter((i) => i.status === 'rejected').length,
          overdue: items.filter((i) => i.overdue).length,
          urgent: items.filter((i) => i.urgency === 'urgent').length,
        },
      };
    });
  }

  /**
   * Send one waiting registration now, rather than at its next backoff.
   *
   * Nothing is re-signed: the same invoice goes again, as a subsequent
   * delivery, which is what the law expects and what CIS de-duplicates. A
   * registration the authority refused is not retried here — its data has to
   * change first, and that is a person's decision.
   */
  async retryNow(fiscalId: string): Promise<FiscalRecord> {
    const tenantId = this.tenant.getRequiredTenantId();
    const { rows } = await this.db.withTenant(tenantId, (client) =>
      client.query<{ status: string }>('SELECT status FROM fiscal_invoices WHERE id = $1', [fiscalId]),
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('That registration does not exist');
    if (row.status === 'fiscalized') {
      throw new BadRequestException('This invoice is already registered with the tax authority.');
    }
    if (row.status === 'rejected') {
      throw new BadRequestException(
        'The tax authority refused this invoice. Correct what it objected to, then issue a corrective invoice.',
      );
    }

    await this.deliver(tenantId, fiscalId);
    const after = await this.db.withTenant(tenantId, (client) =>
      client.query<FiscalRow>('SELECT * FROM fiscal_invoices WHERE id = $1', [fiscalId]),
    );
    return mapFiscal(after.rows[0]!);
  }

  /* ── cash register ────────────────────────────────────────────────── */

  /**
   * The declaration a cash drawer owes CIS, if any (0014).
   *
   *   INITIAL   when the first drawer of the day opens on the clinic's
   *             register — once per register per day, not once per session
   *   WITHDRAW  when cash leaves the drawer for the safe
   *
   * `not_required` when the clinic is not fiscalizing, when the drawer names a
   * register other than the clinic's (a register this clinic has not set up
   * here cannot sign anything), when the amount is in another currency (CIS
   * declarations are in lek), or when today's opening is already declared.
   *
   * Never throws for a fiscal reason: a drawer that opens with its
   * declaration pending is recoverable, a desk that cannot open its drawer
   * because the tax authority is slow is not.
   */
  async declareForDrawer(input: {
    operation: 'INITIAL' | 'WITHDRAW';
    amount: number;
    currency: string;
    drawerTcrCode: string | null;
    drawerSessionId: string;
    actor: ClinicAuditActor;
  }): Promise<{ status: 'not_required' | 'registered' | 'rejected' | 'unreachable' | 'failed'; message: string | null }> {
    const tenantId = this.tenant.getRequiredTenantId();
    const settings = await this.db.withTenant(tenantId, async (client) => {
      const s = await this.settingsRow(client);
      if (!s?.enabled || !s.tcr_code || !s.certificate_pem) return null;
      if (input.drawerTcrCode && input.drawerTcrCode !== s.tcr_code) return null;
      if (input.currency !== 'ALL') return null;
      if (input.operation === 'INITIAL') {
        const { rowCount } = await client.query(
          `SELECT 1 FROM fiscal_cash_deposits
            WHERE operation = 'INITIAL' AND status = 'registered' AND tcr_code = $1
              AND created_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)
            LIMIT 1`,
          [s.tcr_code, FISCAL_TZ],
        );
        if (rowCount) return null;
      }
      return s;
    });
    if (!settings) return { status: 'not_required', message: null };

    try {
      const deposit = await this.registerCashDeposit(
        { operation: input.operation, amount: input.amount },
        input.actor,
        input.drawerSessionId,
      );
      return { status: deposit.status as 'registered' | 'rejected' | 'unreachable', message: deposit.error };
    } catch (e) {
      return { status: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
  }

  async registerCashDeposit(dto: CashDepositDto, actor: ClinicAuditActor, drawerSessionId: string | null = null) {
    const tenantId = this.tenant.getRequiredTenantId();
    const { settings, clinic } = await this.db.withTenant(tenantId, async (client) => ({
      settings: await this.settingsRow(client),
      clinic: await this.clinicRow(client, tenantId),
    }));
    if (!settings?.enabled || !settings.tcr_code || !settings.certificate_pem || !clinic.nipt) {
      throw new BadRequestException('Fiscalization is not turned on for this clinic.');
    }
    const changeDateTime = issueDateTime(new Date(), FISCAL_TZ);
    const key = await this.signingKey(settings, tenantId);
    const unsigned = registerCashDepositXml(
      { nipt: clinic.nipt, tcrCode: settings.tcr_code, operation: dto.operation, amount: dto.amount, changeDateTime },
      newHeader(FISCAL_TZ),
    );
    const envelope = soapEnvelope(await signRequest(unsigned, key, certificateDer(settings.certificate_pem)));
    const answer = await this.post(this.cisUrl(settings.environment), SOAP_ACTION.cash, envelope, 'FCDC');

    const status = answer.kind === 'code' ? 'registered' : answer.kind === 'fault' ? 'rejected' : 'unreachable';
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO fiscal_cash_deposits
           (tenant_id, tcr_code, operation, amount, change_datetime, status, fcdc, last_error, created_by,
            drawer_session_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, operation, amount, change_datetime, status, fcdc, last_error, created_at`,
        [tenantId, settings.tcr_code, dto.operation, dto.amount, changeDateTime, status,
         answer.kind === 'code' ? answer.code : null, answer.kind === 'code' ? null : answer.message, actor.userId,
         drawerSessionId],
      );
      if (status === 'registered') {
        await this.audit.record(client, actor, {
          action: 'fiscal.cash_deposit_registered',
          entityType: 'fiscal_cash_deposit',
          entityId: rows[0].id,
          summary: `Declared ${dto.operation === 'INITIAL' ? 'the opening cash' : 'a cash withdrawal'} for register ${settings.tcr_code}`,
          metadata: { operation: dto.operation, amount: dto.amount },
        });
      }
      return mapDeposit(rows[0]);
    });
  }

  listCashDeposits() {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), async (client) => {
      const { rows } = await client.query(
        `SELECT id, operation, amount, change_datetime, status, fcdc, last_error, created_at
           FROM fiscal_cash_deposits ORDER BY created_at DESC LIMIT 30`,
      );
      return rows.map(mapDeposit);
    });
  }

  /* ── helpers ──────────────────────────────────────────────────────── */

  private async settingsRow(client: PoolClient): Promise<SettingsRow | null> {
    const { rows } = await client.query<SettingsRow>(
      `SELECT enabled, environment, business_unit_code, tcr_code, is_issuer_in_vat,
              vat_exemption_code, certificate_pem, certificate_subject,
              certificate_not_after, private_key_ciphertext, private_key_key_id
         FROM clinic_fiscal_settings LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  private async clinicRow(client: PoolClient, tenantId: string) {
    const { rows } = await client.query<{
      name: string; legal_name: string | null; tax_number: string | null;
      address: string | null; city: string | null; currency: string | null;
    }>(
      `SELECT t.name, cs.legal_name, cs.tax_number, cs.address, cs.city, cs.currency
         FROM tenants t LEFT JOIN clinic_settings cs ON cs.tenant_id = t.id
        WHERE t.id = $1`,
      [tenantId],
    );
    const r = rows[0];
    return {
      name: r?.legal_name?.trim() || r?.name || '',
      nipt: r?.tax_number?.trim().toUpperCase() || null,
      address: r?.address?.trim() || null,
      town: r?.city?.trim() || null,
      currency: r?.currency ?? 'EUR',
    };
  }

  private async signingKey(settings: SettingsRow, tenantId: string) {
    if (!settings.private_key_ciphertext || !settings.private_key_key_id) {
      throw new BadRequestException('No signing certificate is installed.');
    }
    const pkcs8 = open(
      this.keyring,
      { ciphertext: settings.private_key_ciphertext, keyId: settings.private_key_key_id },
      this.aad(tenantId),
    );
    return importSigningKey(Buffer.from(pkcs8, 'base64'));
  }

  /**
   * How the invoice was paid, in the authority's terms. A cash invoice is paid
   * in notes or by card when it is issued; an invoice paid, or to be paid, by
   * bank transfer is non-cash. The two do not mix on one fiscal invoice.
   */
  private async paymentFor(client: PoolClient, invoiceId: string, total: number, status: string) {
    const { rows } = await client.query<{ method: string; amount: string }>(
      `SELECT method, sum(amount)::text AS amount FROM payments
        WHERE invoice_id = $1 AND voided_at IS NULL GROUP BY method`,
      [invoiceId],
    );
    const paid = rows.reduce((s, r) => s + Number(r.amount), 0);
    if (paid === 0) {
      return { type: 'NONCASH' as const, methods: [{ type: 'ACCOUNT' as const, amount: total }] };
    }
    if (status !== 'paid' || paid !== total) {
      throw new BadRequestException(
        'Fiscalize an invoice once it is fully paid, or before any payment when it will be paid by bank transfer.',
      );
    }
    const methods = rows.map((r) => ({ type: PAY_TYPE[r.method] ?? 'BANKNOTE', amount: Number(r.amount) }));
    const bank = methods.some((m) => m.type === 'ACCOUNT');
    if (bank && methods.length > 1) {
      throw new BadRequestException(
        'This invoice was paid partly by bank transfer and partly in cash or by card, which one fiscal invoice cannot show.',
      );
    }
    return { type: bank ? ('NONCASH' as const) : ('CASH' as const), methods };
  }

  private async itemsFor(client: PoolClient, invoiceId: string) {
    const { rows } = await client.query<{
      description: string; quantity: number; unit_price: number; discount_amount: number;
      tax_rate_bp: number; tax_amount: number; amount: number; code: string | null;
    }>(
      `SELECT li.description, li.quantity, li.unit_price, li.discount_amount, li.tax_rate_bp,
              li.tax_amount, li.amount, pc.code
         FROM invoice_line_items li
         LEFT JOIN procedure_codes pc ON pc.id = li.procedure_code_id
        WHERE li.invoice_id = $1
        ORDER BY li.sort_order, li.id`,
      [invoiceId],
    );
    if (rows.length === 0) throw new BadRequestException('An invoice without lines cannot be fiscalized.');
    return rows.map((r) => ({
      name: r.description,
      code: r.code,
      unit: 'copë',
      quantity: r.quantity,
      unitPrice: r.unit_price,
      discountAmount: r.discount_amount,
      taxRateBp: r.tax_rate_bp,
      taxAmount: r.tax_amount,
      total: r.amount,
    }));
  }

  private async post(
    url: string,
    action: string,
    envelope: string,
    codeElement: 'FIC' | 'FCDC',
  ): Promise<
    | { kind: 'code'; code: string; body: string }
    | { kind: 'fault'; code: string | null; message: string; body: string }
    | { kind: 'unreachable'; message: string; body: string | null }
  > {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${action}"` },
        body: envelope,
        signal: AbortSignal.timeout(CIS_TIMEOUT_MS),
      });
    } catch {
      return { kind: 'unreachable', message: 'The tax authority could not be reached; it will be sent again.', body: null };
    }
    const body = await res.text().catch(() => '');
    const answer = parseCisResponse(body, codeElement);
    if (answer.ok) return { kind: 'code', code: answer.code, body };
    // A SOAP fault is the authority's decision. Anything else — a gateway page,
    // an empty 503 — says nothing about the invoice, so it is tried again.
    if (/<(?:\w+:)?Fault[\s>]/.test(body)) {
      this.logger.warn(`CIS refused a request (code ${answer.faultCode ?? 'none'})`);
      return { kind: 'fault', code: answer.faultCode, message: answer.faultString, body };
    }
    return {
      kind: 'unreachable',
      message: `The tax authority answered HTTP ${res.status} without a decision; it will be sent again.`,
      body: body.slice(0, 4000),
    };
  }

  private async settle(
    tenantId: string,
    id: string,
    o: {
      status: 'pending' | 'fiscalized' | 'rejected';
      fic?: string;
      error?: string;
      errorCode?: string | null;
      retryInMinutes?: number;
      request?: string;
      response?: string | null;
    },
  ) {
    try {
      await this.db.withTenant(tenantId, (client) =>
        client.query(
          `UPDATE fiscal_invoices
              SET status = $2::text, fic = $3,
                  fiscalized_at = CASE WHEN $2::text = 'fiscalized' THEN now() ELSE fiscalized_at END,
                  next_attempt_at = CASE WHEN $2::text = 'pending'
                                         THEN now() + make_interval(mins => $4::int) ELSE NULL END,
                  last_error = $5, last_error_code = $6,
                  last_request_xml = coalesce($7, last_request_xml),
                  last_response_xml = coalesce($8, last_response_xml),
                  updated_at = now()
            WHERE id = $1`,
          [id, o.status, o.fic ?? null, o.retryInMinutes ?? 10, o.error ?? null, o.errorCode ?? null,
           o.request ?? null, o.response ?? null],
        ),
      );
    } catch (err) {
      // The authority may already hold it. The row stays pending and the next
      // pass sends it again as a subsequent delivery, which CIS de-duplicates
      // by NSLF.
      this.logger.error(`fiscal invoice ${id}: could not record the outcome: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export async function fiscalRecordFor(client: PoolClient, invoiceId: string): Promise<FiscalRecord | null> {
  const { rows } = await client.query<FiscalRow>('SELECT * FROM fiscal_invoices WHERE invoice_id = $1', [invoiceId]);
  return rows[0] ? mapFiscal(rows[0]) : null;
}

function certificateDer(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

function mapDeposit(r: {
  id: string; operation: string; amount: number; change_datetime: string;
  status: string; fcdc: string | null; last_error: string | null; created_at: string;
}) {
  return {
    id: r.id,
    operation: r.operation,
    amount: r.amount,
    changeDateTime: r.change_datetime,
    status: r.status,
    fcdc: r.fcdc,
    error: r.last_error,
    createdAt: r.created_at,
  };
}
