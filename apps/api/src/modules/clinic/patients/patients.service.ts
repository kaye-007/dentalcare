import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { withdrawEntry } from '@/core/audit/clinical-record';
import { StorageService } from '@/core/storage/storage.service';
import {
  normalizeNationalId,
  toE164,
  WHATSAPP_OPT_IN_SOURCE_LABELS,
} from '@dentalcare/shared';
import { ArchivePatientDto, CreatePatientDto, UpdatePatientDto } from './dto/patient.dto';

interface PatientRow {
  id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  gender: string | null;
  birth_date: string | null;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  status: string;
  created_at: string;
  emergency_contact_name: string | null;
  emergency_contact_relationship: string | null;
  emergency_contact_phone: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  archived_by_name?: string | null;
  reminders_opt_out?: boolean;
  reminders_opt_out_at?: string | null;
  reminders_opt_out_source?: 'staff' | 'patient' | 'provider' | null;
  national_id?: string | null;
  preferred_channel?: string | null;
  photo_document_id?: string | null;
  whatsapp_phone_e164?: string | null;
  whatsapp_opt_in?: boolean;
  whatsapp_opted_in_at?: string | null;
  whatsapp_opt_in_source?: string | null;
}

/**
 * Accents that the desk leaves off when typing a name — Albanian ë and ç
 * above all — and the plain letters they are typed as. Uppercase included,
 * because lower() only folds ASCII under the C locale.
 */
const ACCENTED = 'ëËçÇáàâäãÁÀÂÄÃéèêÉÈÊíìîïÍÌÎÏóòôöõÓÒÔÖÕúùûüÚÙÛÜñÑ';
const PLAIN = 'eeccaaaaaaaaaaeeeeeeiiiiiiiioooooooooouuuuuuuunn';

/** A column folded the same way as `fold`: plain letters, lowercase. */
const FOLD = (col: string) => `lower(translate(${col}, '${ACCENTED}', '${PLAIN}'))`;

/** What was typed, without accents and in lowercase. */
function fold(text: string) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** A unique-index refusal on the national ID, in words. */
function rethrowNationalId(err: unknown): never {
  if ((err as { code?: string; constraint?: string }).code === '23505') {
    throw new ConflictException(
      'Another patient in this clinic already has this national ID',
    );
  }
  throw err;
}

function mapPatient(r: PatientRow) {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    phone: r.phone,
    email: r.email,
    gender: r.gender,
    birthDate: r.birth_date,
    address: r.address,
    city: r.city,
    postalCode: r.postal_code,
    status: r.status,
    createdAt: r.created_at,
    emergencyContact: r.emergency_contact_name
      ? {
          name: r.emergency_contact_name,
          relationship: r.emergency_contact_relationship,
          phone: r.emergency_contact_phone,
        }
      : null,
    archivedAt: r.archived_at,
    archiveReason: r.archive_reason,
    archivedByName: r.archived_by_name ?? null,
    // Whether this patient is sent reminders, and — when not — who decided:
    // staff, the patient replying STOP, or the SMS provider.
    remindersOptOut: r.reminders_opt_out ?? false,
    remindersOptOutAt: r.reminders_opt_out_at ?? null,
    remindersOptOutSource: r.reminders_opt_out_source ?? null,
    nationalId: r.national_id ?? null,
    preferredChannel: r.preferred_channel ?? null,
    photoDocumentId: r.photo_document_id ?? null,
    // Consent to WhatsApp appointment reminders (0017): when, and how it was given.
    whatsappPhone: r.whatsapp_phone_e164 ?? null,
    whatsappOptIn: r.whatsapp_opt_in ?? false,
    whatsappOptedInAt: r.whatsapp_opted_in_at ?? null,
    whatsappOptInSource: r.whatsapp_opt_in_source ?? null,
  };
}

const FULL = `id, first_name, last_name, phone, email, gender,
  birth_date::text AS birth_date, address, city, postal_code, status, created_at,
  emergency_contact_name, emergency_contact_relationship, emergency_contact_phone,
  archived_at, archive_reason,
  reminders_opt_out, reminders_opt_out_at, reminders_opt_out_source,
  national_id, preferred_channel, photo_document_id,
  whatsapp_phone_e164, whatsapp_opt_in, whatsapp_opted_in_at, whatsapp_opt_in_source`;

/**
 * Patients and their notes.
 *
 * Every change is written to the activity trail in the same transaction. The
 * trail records WHICH fields changed, never their values: a phone number or
 * an address in the audit log is a copy of personal data in a table built to
 * be impossible to correct.
 *
 * A patient cannot be deleted by this service or by the database role behind
 * it (0004); a note cannot be edited, only withdrawn as entered in error.
 */
@Injectable()
export class PatientsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
    private readonly storage: StorageService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /**
   * The recall list: active patients whose last completed visit is more than
   * `months` ago, with nothing booked since. Derived, not stored: booking the
   * patient is what takes them off it. Visits older than three years are
   * left out; those patients have moved on, and a list of them is noise.
   */
  recallDue(months: number) {
    return this.tx(async (client) => {
      const { rows } = await client.query<{
        id: string;
        first_name: string;
        last_name: string;
        phone: string | null;
        last_visit: Date;
        last_reason: string | null;
        last_dentist: string | null;
      }>(
        `SELECT p.id, p.first_name, p.last_name, p.phone,
                last.starts_at AS last_visit, last.reason AS last_reason,
                u.full_name AS last_dentist
           FROM patients p
           JOIN LATERAL (
                  SELECT a.starts_at, a.reason, a.staff_id
                    FROM appointments a
                   WHERE a.patient_id = p.id AND a.status = 'completed'
                   ORDER BY a.starts_at DESC
                   LIMIT 1) last ON true
           LEFT JOIN users u ON u.id = last.staff_id
          WHERE p.status = 'active'
            AND last.starts_at < now() - make_interval(months => $1)
            AND last.starts_at > now() - interval '3 years'
            AND NOT EXISTS (
                  SELECT 1 FROM appointments f
                   WHERE f.patient_id = p.id
                     AND f.starts_at > now()
                     AND f.status IN ('scheduled', 'checked_in'))
          ORDER BY last.starts_at DESC
          LIMIT 300`,
        [months],
      );
      return {
        months,
        items: rows.map((r) => ({
          id: r.id,
          firstName: r.first_name,
          lastName: r.last_name,
          phone: r.phone,
          lastVisit: r.last_visit,
          lastReason: r.last_reason,
          lastDentist: r.last_dentist,
        })),
      };
    });
  }

  async list(opts: {
    q?: string;
    status?: string;
    page: number;
    pageSize: number;
    /** Add each patient's next booking (needs appointments:read). */
    withNext?: boolean;
    /** Add each patient's account balance (needs invoices:read). */
    withBalance?: boolean;
  }) {
    const { q, status, page, pageSize } = opts;
    return this.tx(async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (status === 'active' || status === 'inactive' || status === 'archived') {
        params.push(status);
        where.push(`status = $${params.length}`);
      } else {
        // Archived patients are excluded from the default list. They remain
        // reachable by explicitly filtering status=archived.
        where.push(`status <> 'archived'`);
      }
      let orderSql = 'ORDER BY created_at DESC';
      if (q && q.trim()) {
        const term = q.trim();
        params.push(`%${term}%`);
        const i = params.length;
        // A name is found however it is typed: without its ë or ç ("Cela"
        // finds Çela), and in either order ("Kola Erisa" finds Erisa Kola),
        // each word matching the start of a first or last name.
        const words = fold(term).split(/\s+/).filter(Boolean);
        const byWords = words.map((w) => {
          params.push(`${w}%`);
          const k = params.length;
          return `(${FOLD('first_name')} LIKE $${k} OR ${FOLD('last_name')} LIKE $${k}
                   OR ${FOLD('first_name')} LIKE '% ' || $${k}
                   OR ${FOLD('last_name')} LIKE '% ' || $${k})`;
        });
        params.push(`%${fold(term)}%`);
        const folded = `${FOLD("first_name || ' ' || last_name")} LIKE $${params.length}`;
        // A number is typed the way it is said — "069 123 4567" — and stored
        // the way it was entered — "+355 69 123 4567". Compare digits only,
        // without the trunk 0 or the country code, so either finds the other.
        let phoneDigits = '';
        const digits = term.replace(/\D/g, '');
        if (digits.length >= 4 && /^[\d\s+().-]+$/.test(term)) {
          params.push(`%${digits.replace(/^(?:00355|355|0)/, '')}%`);
          phoneDigits = ` OR regexp_replace(coalesce(phone,''), '\\D', '', 'g') LIKE $${params.length}`;
        }
        where.push(
          `(first_name ILIKE $${i} OR last_name ILIKE $${i} OR coalesce(phone,'') ILIKE $${i}
            OR coalesce(email,'') ILIKE $${i} OR (first_name || ' ' || last_name) ILIKE $${i}
            OR coalesce(national_id,'') ILIKE $${i}${phoneDigits}
            OR ${folded}${byWords.length ? ` OR (${byWords.join(' AND ')})` : ''})`,
        );
        // Whoever's name starts with what was typed comes first; the rest
        // alphabetically, which is how the desk scans a list of namesakes.
        params.push(`${fold(term)}%`);
        const p = params.length;
        orderSql = `ORDER BY (${FOLD('first_name')} LIKE $${p} OR ${FOLD('last_name')} LIKE $${p}
                              OR ${FOLD("first_name || ' ' || last_name")} LIKE $${p}) DESC,
                             first_name, last_name`;
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      params.push(pageSize, (page - 1) * pageSize);
      const { rows } = await client.query<PatientRow & { total: string }>(
        `SELECT id, first_name, last_name, phone, email, city, status, created_at,
                count(*) OVER() AS total
           FROM patients ${whereSql}
          ${orderSql}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const total = rows[0] ? Number(rows[0].total) : 0;

      // What the desk asks of a list — when are they next in, do they owe —
      // for this page's patients only, in one query each.
      const ids = rows.map((r) => r.id);
      const next = new Map<string, Date>();
      const balance = new Map<string, number>();
      if (ids.length && opts.withNext) {
        const { rows: n } = await client.query<{ patient_id: string; starts_at: Date }>(
          `SELECT patient_id, min(starts_at) AS starts_at
             FROM appointments
            WHERE patient_id = ANY($1::uuid[]) AND starts_at > now()
              AND status IN ('scheduled', 'checked_in')
            GROUP BY patient_id`,
          [ids],
        );
        for (const r of n) next.set(r.patient_id, r.starts_at);
      }
      if (ids.length && opts.withBalance) {
        const { rows: b } = await client.query<{ patient_id: string; balance: string }>(
          `SELECT patient_id, sum(amount)::text AS balance
             FROM ledger_entries
            WHERE patient_id = ANY($1::uuid[])
            GROUP BY patient_id`,
          [ids],
        );
        for (const r of b) balance.set(r.patient_id, Number(r.balance));
      }

      return {
        items: rows.map((r) => ({
          id: r.id,
          firstName: r.first_name,
          lastName: r.last_name,
          phone: r.phone,
          email: r.email,
          city: r.city,
          status: r.status,
          createdAt: r.created_at,
          ...(opts.withNext ? { nextAppointmentAt: next.get(r.id) ?? null } : {}),
          ...(opts.withBalance ? { balance: balance.get(r.id) ?? 0 } : {}),
        })),
        total,
        page,
        pageSize,
      };
    });
  }

  async getById(id: string) {
    return this.tx(async (client) => {
      const { rows } = await client.query<PatientRow>(
        `SELECT ${FULL} FROM patients WHERE id = $1`,
        [id],
      );
      if (!rows[0]) throw new NotFoundException('Patient not found');

      const { rows: archiver } = await client.query<{ full_name: string | null }>(
        `SELECT u.full_name FROM patients p
           LEFT JOIN users u ON u.id = p.archived_by
          WHERE p.id = $1`,
        [id],
      );
      rows[0].archived_by_name = archiver[0]?.full_name ?? null;

      // Allergy severity travels with the patient record so no screen that
      // loads a patient can fail to know about a severe allergy.
      const { rows: allergyRows } = await client.query<{
        severity: 'mild' | 'moderate' | 'severe';
        substance: string;
      }>(
        `SELECT severity, substance FROM patient_allergies
          WHERE patient_id = $1 AND entered_in_error_at IS NULL
          ORDER BY CASE severity
                     WHEN 'severe' THEN 0 WHEN 'moderate' THEN 1 ELSE 2
                   END, lower(substance)`,
        [id],
      );

      const notes = await client.query(
        `SELECT n.id, n.body, n.created_at, u.full_name AS author_name
           FROM patient_notes n
           LEFT JOIN users u ON u.id = n.author_id
          WHERE n.patient_id = $1 AND n.entered_in_error_at IS NULL
          ORDER BY n.created_at DESC`,
        [id],
      );

      // The profile photo travels as a short-lived link. Opening the record
      // is already in the access log, and the picture is part of the record.
      let photoUrl: string | null = null;
      if (rows[0].photo_document_id && this.storage.isConfigured) {
        const { rows: photo } = await client.query<{ storage_key: string }>(
          'SELECT storage_key FROM patient_documents WHERE id = $1 AND deleted_at IS NULL',
          [rows[0].photo_document_id],
        );
        if (photo[0])
          photoUrl = await this.storage
            .signedViewUrl(photo[0].storage_key)
            .catch(() => null);
      }
      return {
        ...mapPatient(rows[0]),
        photoUrl,
        notes: notes.rows,
        allergySummary: {
          count: allergyRows.length,
          hasSevere: allergyRows.some((a) => a.severity === 'severe'),
          substances: allergyRows.map((a) => a.substance),
        },
      };
    });
  }

  async create(dto: CreatePatientDto, actor: ClinicAuditActor) {
    // Only first and last name are mandatory; every other field is optional.
    // Normalize empty strings to NULL so direct API clients are not forced
    // to omit keys to pass validation downstream.
    const opt = (v: string | undefined) => (v && v.trim() !== '' ? v : null);
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client
        .query<PatientRow>(
          `INSERT INTO patients
           (tenant_id, first_name, last_name, phone, email, gender, birth_date,
            address, city, postal_code, status, created_by,
            emergency_contact_name, emergency_contact_relationship,
            emergency_contact_phone, national_id, preferred_channel)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING ${FULL}`,
          [
            tenantId,
            dto.firstName,
            dto.lastName,
            opt(dto.phone),
            opt(dto.email),
            dto.gender && (dto.gender as string) !== '' ? dto.gender : null,
            opt(dto.birthDate),
            opt(dto.address),
            opt(dto.city),
            opt(dto.postalCode),
            // A patient cannot be created straight into the archive; archiving
            // is an explicit, attributed action.
            dto.status === 'archived' ? 'active' : (dto.status ?? 'active'),
            actor.userId,
            opt(dto.emergencyContactName),
            opt(dto.emergencyContactRelationship),
            opt(dto.emergencyContactPhone),
            dto.nationalId ? normalizeNationalId(dto.nationalId) : null,
            dto.preferredChannel || null,
          ],
        )
        .catch(rethrowNationalId);
      const row = rows[0]!;
      await this.audit.record(client, actor, {
        action: 'patient.created',
        entityType: 'patient',
        entityId: row.id,
        summary: `Registered ${row.first_name} ${row.last_name}`,
      });
      return mapPatient((await this.applyWhatsApp(client, row.id, dto, actor)) ?? row);
    });
  }

  /**
   * The WhatsApp number and consent (0017). Agreeing stamps when and how, and
   * — being a fresh yes — lifts an earlier opt-out; withdrawing clears both.
   * A change of consent is its own audit entry: it is the record that the
   * clinic was allowed to write to this patient.
   */
  private async applyWhatsApp(
    client: PoolClient,
    id: string,
    dto: CreatePatientDto,
    actor: ClinicAuditActor,
  ): Promise<PatientRow | null> {
    if (
      dto.whatsappPhone === undefined &&
      dto.whatsappOptIn === undefined &&
      dto.whatsappOptInSource === undefined
    ) {
      return null;
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (dto.whatsappPhone !== undefined) {
      let e164: string | null = null;
      if (dto.whatsappPhone && dto.whatsappPhone.trim() !== '') {
        const cc = await client.query<{ phone_country_code: string }>(
          'SELECT phone_country_code FROM clinic_settings LIMIT 1',
        );
        e164 = toE164(dto.whatsappPhone, cc.rows[0]?.phone_country_code ?? '355');
        if (!e164)
          throw new BadRequestException(
            `"${dto.whatsappPhone}" is not a usable WhatsApp number`,
          );
      }
      params.push(e164);
      sets.push(`whatsapp_phone_e164 = $${params.length}`);
    }
    if (dto.whatsappOptIn !== undefined) {
      params.push(dto.whatsappOptIn);
      const yes = `$${params.length}::boolean`;
      params.push(dto.whatsappOptInSource ?? null);
      const source = `$${params.length}::text`;
      sets.push(
        `whatsapp_opt_in = ${yes}`,
        `whatsapp_opted_in_at = CASE WHEN ${yes} THEN coalesce(whatsapp_opted_in_at, now()) END`,
        `whatsapp_opt_in_source = CASE WHEN ${yes} THEN coalesce(${source}, whatsapp_opt_in_source, 'in_person') END`,
        `reminders_opt_out = CASE WHEN ${yes} THEN false ELSE reminders_opt_out END`,
        `reminders_opt_out_at = CASE WHEN ${yes} THEN NULL ELSE reminders_opt_out_at END`,
        `reminders_opt_out_source = CASE WHEN ${yes} THEN NULL ELSE reminders_opt_out_source END`,
      );
    } else if (dto.whatsappOptInSource !== undefined) {
      params.push(dto.whatsappOptInSource);
      sets.push(
        `whatsapp_opt_in_source = CASE WHEN whatsapp_opt_in THEN $${params.length} END`,
      );
    }
    const before = await client.query<{ whatsapp_opt_in: boolean }>(
      'SELECT whatsapp_opt_in FROM patients WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!before.rows[0]) throw new NotFoundException('Patient not found');
    const { rows } = await client.query<PatientRow>(
      `UPDATE patients SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${FULL}`,
      params,
    );
    const row = rows[0]!;
    if (
      dto.whatsappOptIn !== undefined &&
      dto.whatsappOptIn !== before.rows[0].whatsapp_opt_in
    ) {
      const how = row.whatsapp_opt_in_source as
        keyof typeof WHATSAPP_OPT_IN_SOURCE_LABELS | null;
      await this.audit.record(client, actor, {
        action: 'patient.whatsapp_consent',
        entityType: 'patient',
        entityId: id,
        summary: dto.whatsappOptIn
          ? `${row.first_name} ${row.last_name} agreed to WhatsApp reminders (${how ? WHATSAPP_OPT_IN_SOURCE_LABELS[how].toLowerCase() : 'in person'})`
          : `${row.first_name} ${row.last_name} no longer agrees to WhatsApp reminders`,
        metadata: { optIn: dto.whatsappOptIn, source: how },
      });
    }
    return row;
  }

  async update(id: string, dto: UpdatePatientDto, actor: ClinicAuditActor) {
    const map: Record<string, string> = {
      firstName: 'first_name',
      lastName: 'last_name',
      phone: 'phone',
      email: 'email',
      gender: 'gender',
      birthDate: 'birth_date',
      address: 'address',
      city: 'city',
      postalCode: 'postal_code',
      status: 'status',
      emergencyContactName: 'emergency_contact_name',
      emergencyContactRelationship: 'emergency_contact_relationship',
      emergencyContactPhone: 'emergency_contact_phone',
      nationalId: 'national_id',
      preferredChannel: 'preferred_channel',
    };
    if (typeof dto.nationalId === 'string' && dto.nationalId.trim() !== '') {
      dto.nationalId = normalizeNationalId(dto.nationalId);
    }
    // Archiving carries a reason and an actor, so it has its own endpoint.
    // Allowing it through the generic PATCH would bypass both.
    if (dto.status === 'archived') {
      throw new BadRequestException('Use DELETE /patients/:id to archive a patient');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const fields: string[] = [];
    for (const [k, col] of Object.entries(map)) {
      const v = (dto as unknown as Record<string, unknown>)[k];
      if (v !== undefined) {
        params.push(v === '' || v === null ? null : v);
        sets.push(`${col} = $${params.length}`);
        fields.push(k);
      }
    }
    // Opting out stamps when, and opting back in clears it, so the three
    // columns can never disagree — 0008 checks that they do not. A source set
    // by the patient or the provider is kept if staff tick the box again.
    if (dto.remindersOptOut !== undefined) {
      params.push(dto.remindersOptOut);
      const p = `$${params.length}::boolean`;
      sets.push(
        `reminders_opt_out = ${p}`,
        `reminders_opt_out_at = CASE WHEN ${p} THEN coalesce(reminders_opt_out_at, now()) END`,
        `reminders_opt_out_source = CASE WHEN ${p} THEN coalesce(reminders_opt_out_source, 'staff') END`,
      );
      fields.push('remindersOptOut');
    }
    return this.tx(async (client) => {
      if (sets.length === 0) {
        const whatsapp = await this.applyWhatsApp(client, id, dto, actor);
        if (whatsapp) return mapPatient(whatsapp);
        const cur = await client.query<PatientRow>(
          `SELECT ${FULL} FROM patients WHERE id = $1`,
          [id],
        );
        if (!cur.rows[0]) throw new NotFoundException('Patient not found');
        return mapPatient(cur.rows[0]);
      }
      params.push(id);
      const { rows } = await client
        .query<PatientRow>(
          `UPDATE patients SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $${params.length} RETURNING ${FULL}`,
          params,
        )
        .catch(rethrowNationalId);
      const row = rows[0];
      if (!row) throw new NotFoundException('Patient not found');
      await this.audit.record(client, actor, {
        action: 'patient.updated',
        entityType: 'patient',
        entityId: id,
        summary: `Updated ${row.first_name} ${row.last_name}'s details (${fields.join(', ')})`,
        metadata: { fields },
      });
      return mapPatient((await this.applyWhatsApp(client, id, dto, actor)) ?? row);
    });
  }

  /**
   * Archive a patient. Not a DELETE: dental records carry retention duties and
   * are referenced by appointments, invoices and tooth records, so the row is
   * kept and flagged with who archived it, when, and why.
   */
  async archive(id: string, dto: ArchivePatientDto, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const { rows: current } = await client.query<{ status: string }>(
        'SELECT status FROM patients WHERE id = $1',
        [id],
      );
      if (!current[0]) throw new NotFoundException('Patient not found');
      if (current[0].status === 'archived') {
        throw new ConflictException('This patient is already archived');
      }

      // Surfaced so the UI can warn before hiding someone with money owing.
      const { rows: open } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM appointments
          WHERE patient_id = $1
            AND status = 'scheduled'
            AND starts_at >= now()`,
        [id],
      );

      const reason = dto.reason?.trim() || null;
      const { rows } = await client.query<PatientRow>(
        `UPDATE patients
            SET status = 'archived', archived_at = now(),
                archived_by = $2, archive_reason = $3, updated_at = now()
          WHERE id = $1
          RETURNING ${FULL}`,
        [id, actor.userId, reason],
      );
      const row = rows[0]!;
      await this.audit.record(client, actor, {
        action: 'patient.archived',
        entityType: 'patient',
        entityId: id,
        summary: `Archived ${row.first_name} ${row.last_name}${reason ? `: ${reason}` : ''}`,
        metadata: reason ? { reason } : {},
      });
      return {
        ...mapPatient(row),
        upcomingAppointmentsAffected: Number(open[0]?.count ?? 0),
      };
    });
  }

  /** Undo an archive. The reason is cleared; the activity trail keeps it. */
  async restore(id: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const { rows } = await client.query<PatientRow>(
        `UPDATE patients
            SET status = 'active', archived_at = NULL,
                archived_by = NULL, archive_reason = NULL, updated_at = now()
          WHERE id = $1 AND status = 'archived'
          RETURNING ${FULL}`,
        [id],
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundException('No archived patient with that id');
      }
      await this.audit.record(client, actor, {
        action: 'patient.restored',
        entityType: 'patient',
        entityId: id,
        summary: `Restored ${row.first_name} ${row.last_name} from the archive`,
      });
      return mapPatient(row);
    });
  }

  async addNote(patientId: string, body: string, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rows: patient } = await client.query<{ name: string }>(
        `SELECT first_name || ' ' || last_name AS name FROM patients WHERE id = $1`,
        [patientId],
      );
      if (!patient[0]) throw new NotFoundException('Patient not found');
      const { rows } = await client.query<{
        id: string;
        body: string;
        created_at: string;
      }>(
        `INSERT INTO patient_notes (tenant_id, patient_id, body, author_id)
         VALUES ($1,$2,$3,$4)
         RETURNING id, body, created_at`,
        [tenantId, patientId, body, actor.userId],
      );
      const note = rows[0]!;
      await this.audit.record(client, actor, {
        action: 'clinical.note_added',
        entityType: 'patient_note',
        entityId: note.id,
        summary: `Added a note for ${patient[0].name}`,
        metadata: { patientId },
      });
      return note;
    });
  }

  /** Withdraw a note as entered in error. Notes are never edited or deleted. */
  async withdrawNote(noteId: string, reason: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      await withdrawEntry<{ patient_id: string; entered_in_error_at: unknown }>(
        client,
        this.audit,
        actor,
        {
          table: 'patient_notes',
          id: noteId,
          reason,
          action: 'clinical.note_withdrawn',
          describe: () => 'a note',
        },
      );
      return { withdrawn: true as const };
    });
  }
}
