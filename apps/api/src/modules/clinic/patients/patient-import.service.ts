import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import {
  IMPORT_FIELDS,
  duplicatesWithinFile,
  formatMoney,
  normalizeImportRow,
  toE164,
  type ImportIssue,
  type ImportedPatient,
  type RawImportRow,
} from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { clinicCurrency } from '@/core/money/clinic-currency';
import { ImportBatchDto } from './dto/patient-import.dto';

export type ImportRowStatus = 'valid' | 'invalid' | 'duplicate';

export interface ImportRowResult {
  /** 1-based line in the file, not counting the header. */
  row: number;
  status: ImportRowStatus;
  name: string;
  errors: ImportIssue[];
  duplicateOf:
    | { kind: 'file'; row: number }
    | { kind: 'patient'; patientId: string; name: string; match: 'nationalId' | 'phone' }
    | null;
}

interface Checked {
  results: ImportRowResult[];
  values: ImportedPatient[];
}

/** The fields a row may carry; anything else a client sends is ignored. */
function rawRow(input: Record<string, unknown>): RawImportRow {
  const out: RawImportRow = {};
  for (const field of IMPORT_FIELDS) {
    const v = input[field];
    if (typeof v === 'string') out[field] = v.slice(0, 2000);
    else if (typeof v === 'number') out[field] = String(v);
  }
  return out;
}

/**
 * Bulk patient import from a spreadsheet or a legacy system.
 *
 * ── Preview, then commit ──────────────────────────────────────────────────
 *
 * Preview runs every rule and every duplicate check and writes nothing. Commit
 * runs them again — the browser's preview is advice, and the clinic's records
 * may have changed since — and inserts, in ONE transaction per batch, the
 * patients, their medical conditions, their opening balances and a record of
 * the import. A batch either lands whole or not at all.
 *
 * ── Duplicates ────────────────────────────────────────────────────────────
 *
 * A national ID match is the same person, always skipped; the database
 * refuses a second record with that ID in any case. A phone match is probably
 * the same person — but families share a landline — so it is skipped unless
 * the person importing says otherwise.
 *
 * ── What an opening balance is ────────────────────────────────────────────
 *
 * A ledger adjustment, positive when the patient owes the clinic. It is not
 * an invoice, because nothing was billed in this system, and not a payment,
 * because no money arrived. It carries the file name, so an auditor can see
 * where the number came from. Money evidence is append-only: a wrong balance
 * is corrected by an opposing adjustment, like any other.
 */
@Injectable()
export class PatientImportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
  ) {}

  preview(dto: ImportBatchDto) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), async (client) => {
      const { results } = await this.check(client, dto);
      return summarise(results);
    });
  }

  commit(dto: ImportBatchDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { results, values } = await this.check(client, dto);

      const take: { value: ImportedPatient; id: string }[] = [];
      results.forEach((r, i) => {
        const phoneOnly =
          r.duplicateOf?.kind === 'patient' && r.duplicateOf.match === 'phone';
        if (
          r.status === 'valid' ||
          (r.status === 'duplicate' && phoneOnly && !dto.skipDuplicates)
        ) {
          take.push({ value: values[i]!, id: randomUUID() });
        }
      });

      const balancesTotal = take.reduce((s, t) => s + t.value.balance, 0);
      const batch = await client.query<{ id: string }>(
        `INSERT INTO patient_imports
           (tenant_id, file_name, source_label, rows_received, rows_imported, rows_skipped,
            balances_total, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          tenantId,
          dto.fileName.trim(),
          dto.sourceLabel?.trim() || null,
          results.length,
          take.length,
          results.length - take.length,
          balancesTotal,
          actor.userId,
        ],
      );
      const batchId = batch.rows[0]!.id;

      if (take.length > 0) {
        const col = <K extends keyof ImportedPatient>(k: K) =>
          take.map((t) => t.value[k] ?? null);
        await client.query(
          `INSERT INTO patients
             (id, tenant_id, first_name, last_name, phone, email, gender, birth_date,
              national_id, address, city, status, created_by, import_batch_id)
           SELECT id, $1, f, l, ph, em, g, bd::date, nid, ad, ci, 'active', $2, $3
             FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                         $10::text[], $11::text[], $12::text[], $13::text[])
                  AS t(id, f, l, ph, em, g, bd, nid, ad, ci)`,
          [
            tenantId,
            actor.userId,
            batchId,
            take.map((t) => t.id),
            col('firstName'),
            col('lastName'),
            col('phone'),
            col('email'),
            col('gender'),
            col('birthDate'),
            col('nationalId'),
            col('address'),
            col('city'),
          ],
        );

        const conditions = take.flatMap((t) =>
          t.value.conditions.map((name) => [t.id, name] as const),
        );
        if (conditions.length > 0) {
          await client.query(
            `INSERT INTO patient_conditions (tenant_id, patient_id, name, status, recorded_by)
             SELECT $1, pid, n, 'active', $2 FROM unnest($3::uuid[], $4::text[]) AS t(pid, n)`,
            [
              tenantId,
              actor.userId,
              conditions.map((c) => c[0]),
              conditions.map((c) => c[1]),
            ],
          );
        }

        const balances = take.filter((t) => t.value.balance !== 0);
        if (balances.length > 0) {
          await client.query(
            `INSERT INTO ledger_entries
               (tenant_id, patient_id, entry_type, amount, currency, description, created_by)
             SELECT $1, pid, 'adjustment', amt, $2, $3, $4
               FROM unnest($5::uuid[], $6::int[]) AS t(pid, amt)`,
            [
              tenantId,
              await clinicCurrency(client),
              `Opening balance imported from ${dto.fileName.trim()}`.slice(0, 200),
              actor.userId,
              balances.map((b) => b.id),
              balances.map((b) => b.value.balance),
            ],
          );
        }
      }

      const currency = await clinicCurrency(client);
      await this.audit.record(client, actor, {
        action: 'patient.imported',
        entityType: 'patient_import',
        entityId: batchId,
        summary:
          `Imported ${take.length} of ${results.length} patient(s) from ${dto.fileName.trim()}` +
          (balancesTotal !== 0
            ? `, with ${formatMoney(balancesTotal, currency)} in opening balances`
            : ''),
        metadata: {
          fileName: dto.fileName.trim(),
          received: results.length,
          imported: take.length,
          balancesTotal,
        },
      });

      const importedIds = new Map(take.map((t) => [t.value, t.id]));
      return {
        importId: batchId,
        imported: take.length,
        skipped: results.length - take.length,
        rows: results.map((r, i) => ({
          ...r,
          patientId: importedIds.get(values[i]!) ?? null,
        })),
      };
    });
  }

  listImports() {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), async (client) => {
      const { rows } = await client.query(
        `SELECT pi.id, pi.file_name, pi.source_label, pi.rows_received, pi.rows_imported,
                pi.rows_skipped, pi.balances_total, pi.created_at, u.full_name AS created_by_name
           FROM patient_imports pi
           LEFT JOIN users u ON u.id = pi.created_by
          ORDER BY pi.created_at DESC LIMIT 50`,
      );
      return rows.map((r) => ({
        id: r.id,
        fileName: r.file_name,
        sourceLabel: r.source_label,
        rowsReceived: r.rows_received,
        rowsImported: r.rows_imported,
        rowsSkipped: r.rows_skipped,
        balancesTotal: r.balances_total,
        createdAt: r.created_at,
        createdByName: r.created_by_name,
      }));
    });
  }

  /** Every rule and every duplicate check, for one batch. Reads only. */
  private async check(client: PoolClient, dto: ImportBatchDto): Promise<Checked> {
    const { rows: cs } = await client.query<{ phone_country_code: string | null }>(
      'SELECT phone_country_code FROM clinic_settings LIMIT 1',
    );
    const countryCode = cs[0]?.phone_country_code ?? '355';

    const normalized = dto.rows.map((r) =>
      normalizeImportRow(rawRow(r), { dateFormat: dto.dateFormat, countryCode }),
    );
    const values = normalized.map((n) => n.value);
    const inFile = duplicatesWithinFile(values);

    // Candidates by the last eight digits of a phone, then compared exactly as
    // E.164 in code — the stored numbers were typed by people, in every form.
    const tails = [
      ...new Set(
        values.map((v) => v.phoneE164?.slice(-8)).filter((t): t is string => Boolean(t)),
      ),
    ];
    const ids = [
      ...new Set(values.map((v) => v.nationalId).filter((v): v is string => Boolean(v))),
    ];
    const { rows: existing } =
      tails.length || ids.length
        ? await client.query<{
            id: string;
            name: string;
            phone: string | null;
            nid: string | null;
          }>(
            `SELECT id, first_name || ' ' || last_name AS name, phone,
                  upper(regexp_replace(national_id, '\\s', '', 'g')) AS nid
             FROM patients
            WHERE right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 8) = ANY($1::text[])
               OR upper(regexp_replace(coalesce(national_id, ''), '\\s', '', 'g')) = ANY($2::text[])`,
            [tails, ids],
          )
        : { rows: [] };
    const byId = new Map(existing.filter((e) => e.nid).map((e) => [e.nid!, e]));
    const byPhone = new Map<string, (typeof existing)[number]>();
    for (const e of existing) {
      const e164 = toE164(e.phone, countryCode);
      if (e164 && !byPhone.has(e164)) byPhone.set(e164, e);
    }

    const results = normalized.map(({ value, errors }, i): ImportRowResult => {
      const row = dto.rowOffset + i + 1;
      const name = `${value.firstName} ${value.lastName}`.trim();
      if (errors.length > 0)
        return { row, status: 'invalid', name, errors, duplicateOf: null };
      const fileDupe = inFile.get(i);
      if (fileDupe !== undefined) {
        return {
          row,
          status: 'duplicate',
          name,
          errors,
          duplicateOf: { kind: 'file', row: dto.rowOffset + fileDupe + 1 },
        };
      }
      const idMatch = value.nationalId ? byId.get(value.nationalId) : undefined;
      if (idMatch) {
        return {
          row,
          status: 'duplicate',
          name,
          errors,
          duplicateOf: {
            kind: 'patient',
            patientId: idMatch.id,
            name: idMatch.name,
            match: 'nationalId',
          },
        };
      }
      const phoneMatch = value.phoneE164 ? byPhone.get(value.phoneE164) : undefined;
      if (phoneMatch) {
        return {
          row,
          status: 'duplicate',
          name,
          errors,
          duplicateOf: {
            kind: 'patient',
            patientId: phoneMatch.id,
            name: phoneMatch.name,
            match: 'phone',
          },
        };
      }
      return { row, status: 'valid', name, errors, duplicateOf: null };
    });
    return { results, values };
  }
}

function summarise(results: ImportRowResult[]) {
  return {
    valid: results.filter((r) => r.status === 'valid').length,
    invalid: results.filter((r) => r.status === 'invalid').length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
    rows: results,
  };
}
