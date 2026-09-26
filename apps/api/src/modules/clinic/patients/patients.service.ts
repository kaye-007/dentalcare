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
import { normalizeNationalId } from '@dentalcare/shared';
import {
  ArchivePatientDto,
  CreatePatientDto,
  UpdatePatientDto,
} from './dto/patient.dto';

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
}

/** A unique-index refusal on the national ID, in words. */
function rethrowNationalId(err: unknown): never {
  if ((err as { code?: string; constraint?: string }).code === '23505') {
    throw new ConflictException('Another patient in this clinic already has this national ID');
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
  };
}

const FULL = `id, first_name, last_name, phone, email, gender,
  birth_date::text AS birth_date, address, city, postal_code, status, created_at,
  emergency_contact_name, emergency_contact_relationship, emergency_contact_phone,
  archived_at, archive_reason,
  reminders_opt_out, reminders_opt_out_at, reminders_opt_out_source,
  national_id, preferred_channel, photo_document_id`;

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

  async list(opts: { q?: string; status?: string; page: number; pageSize: number }) {
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
      if (q && q.trim()) {
        params.push(`%${q.trim()}%`);
        const i = params.length;
        where.push(
          `(first_name ILIKE $${i} OR last_name ILIKE $${i} OR coalesce(phone,'') ILIKE $${i}
            OR coalesce(email,'') ILIKE $${i} OR (first_name || ' ' || last_name) ILIKE $${i}
            OR coalesce(national_id,'') ILIKE $${i})`,
        );
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      params.push(pageSize, (page - 1) * pageSize);
      const { rows } = await client.query<PatientRow & { total: string }>(
        `SELECT id, first_name, last_name, phone, email, city, status, created_at,
                count(*) OVER() AS total
           FROM patients ${whereSql}
          ORDER BY created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const total = rows[0] ? Number(rows[0].total) : 0;
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
        if (photo[0]) photoUrl = await this.storage.signedViewUrl(photo[0].storage_key).catch(() => null);
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
      const { rows } = await client.query<PatientRow>(
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
          dto.status === 'archived' ? 'active' : dto.status ?? 'active',
          actor.userId,
          opt(dto.emergencyContactName),
          opt(dto.emergencyContactRelationship),
          opt(dto.emergencyContactPhone),
          dto.nationalId ? normalizeNationalId(dto.nationalId) : null,
          dto.preferredChannel || null,
        ],
      ).catch(rethrowNationalId);
      const row = rows[0]!;
      await this.audit.record(client, actor, {
        action: 'patient.created',
        entityType: 'patient',
        entityId: row.id,
        summary: `Registered ${row.first_name} ${row.last_name}`,
      });
      return mapPatient(row);
    });
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
      throw new BadRequestException(
        'Use DELETE /patients/:id to archive a patient',
      );
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
      return mapPatient(row);
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
      const { rows } = await client.query<{ id: string; body: string; created_at: string }>(
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
