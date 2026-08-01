import { Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { CreatePatientDto, UpdatePatientDto } from './dto/patient.dto';

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
  };
}

const FULL = `id, first_name, last_name, phone, email, gender,
  birth_date::text AS birth_date, address, city, postal_code, status, created_at`;

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
      if (status === 'active' || status === 'inactive') {
        params.push(status);
        where.push(`status = $${params.length}`);
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
      const notes = await client.query(
        `SELECT n.id, n.body, n.created_at, u.full_name AS author_name
           FROM patient_notes n
           LEFT JOIN users u ON u.id = n.author_id
          WHERE n.patient_id = $1
          ORDER BY n.created_at DESC`,
        [id],
      );
      return { ...mapPatient(rows[0]), notes: notes.rows };
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
            address, city, postal_code, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
          dto.status ?? 'active',
          userId,
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
    };
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
