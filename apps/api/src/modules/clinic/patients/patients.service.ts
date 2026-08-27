import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
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
  };
}

const FULL = `id, first_name, last_name, phone, email, gender,
  birth_date::text AS birth_date, address, city, postal_code, status, created_at,
  emergency_contact_name, emergency_contact_relationship, emergency_contact_phone,
  archived_at, archive_reason`;

@Injectable()
export class PatientsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
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
            OR coalesce(email,'') ILIKE $${i} OR (first_name || ' ' || last_name) ILIKE $${i})`,
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
          WHERE patient_id = $1
          ORDER BY CASE severity
                     WHEN 'severe' THEN 0 WHEN 'moderate' THEN 1 ELSE 2
                   END, lower(substance)`,
        [id],
      );

      const notes = await client.query(
        `SELECT n.id, n.body, n.created_at, u.full_name AS author_name
           FROM patient_notes n
           LEFT JOIN users u ON u.id = n.author_id
          WHERE n.patient_id = $1
          ORDER BY n.created_at DESC`,
        [id],
      );
      return {
        ...mapPatient(rows[0]),
        notes: notes.rows,
        allergySummary: {
          count: allergyRows.length,
          hasSevere: allergyRows.some((a) => a.severity === 'severe'),
          substances: allergyRows.map((a) => a.substance),
        },
      };
    });
  }

  async create(dto: CreatePatientDto, userId: string) {
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
            emergency_contact_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
          userId,
          opt(dto.emergencyContactName),
          opt(dto.emergencyContactRelationship),
          opt(dto.emergencyContactPhone),
        ],
      );
      return mapPatient(rows[0]!);
    });
  }

  async update(id: string, dto: UpdatePatientDto) {
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
    };
    // Archiving carries a reason and an actor, so it has its own endpoint.
    // Allowing it through the generic PATCH would bypass both.
    if (dto.status === 'archived') {
      throw new BadRequestException(
        'Use DELETE /patients/:id to archive a patient',
      );
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, col] of Object.entries(map)) {
      const v = (dto as unknown as Record<string, unknown>)[k];
      if (v !== undefined) {
        params.push(v === '' ? null : v);
        sets.push(`${col} = $${params.length}`);
      }
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
      const { rows } = await client.query<PatientRow>(
        `UPDATE patients SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length} RETURNING ${FULL}`,
        params,
      );
      if (!rows[0]) throw new NotFoundException('Patient not found');
      return mapPatient(rows[0]);
    });
  }

  /**
   * Archive a patient. Not a DELETE: dental records carry retention duties and
   * are referenced by appointments, invoices and tooth records, so the row is
   * kept and flagged with who archived it, when, and why.
   */
  async archive(id: string, dto: ArchivePatientDto, userId: string) {
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

      const { rows } = await client.query<PatientRow>(
        `UPDATE patients
            SET status = 'archived', archived_at = now(),
                archived_by = $2, archive_reason = $3, updated_at = now()
          WHERE id = $1
          RETURNING ${FULL}`,
        [id, userId, dto.reason?.trim() || null],
      );
      return {
        ...mapPatient(rows[0]),
        upcomingAppointmentsAffected: Number(open[0]?.count ?? 0),
      };
    });
  }

  /** Undo an archive. The reason is cleared; the audit trail is the notes. */
  async restore(id: string) {
    return this.tx(async (client) => {
      const { rows } = await client.query<PatientRow>(
        `UPDATE patients
            SET status = 'active', archived_at = NULL,
                archived_by = NULL, archive_reason = NULL, updated_at = now()
          WHERE id = $1 AND status = 'archived'
          RETURNING ${FULL}`,
        [id],
      );
      if (!rows[0]) {
        throw new NotFoundException('No archived patient with that id');
      }
      return mapPatient(rows[0]);
    });
  }

  async addNote(patientId: string, body: string, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const exists = await client.query('SELECT 1 FROM patients WHERE id = $1', [
        patientId,
      ]);
      if (!exists.rowCount) throw new NotFoundException('Patient not found');
      const { rows } = await client.query(
        `INSERT INTO patient_notes (tenant_id, patient_id, body, author_id)
         VALUES ($1,$2,$3,$4)
         RETURNING id, body, created_at`,
        [tenantId, patientId, body, userId],
      );
      return rows[0];
    });
  }

  async deleteNote(noteId: string) {
    return this.tx(async (client) => {
      const res = await client.query('DELETE FROM patient_notes WHERE id = $1', [
        noteId,
      ]);
      if (!res.rowCount) throw new NotFoundException('Note not found');
      return { deleted: true };
    });
  }
}
