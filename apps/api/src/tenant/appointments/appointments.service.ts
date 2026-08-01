import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { CreateAppointmentDto, UpdateAppointmentDto } from './dto/appointment.dto';

interface ApptRow {
  id: string;
  patient_id: string;
  patient_name: string;
  staff_id: string | null;
  staff_name: string | null;
  reason: string;
  status: string;
  starts_at: string;
  ends_at: string;
}

const SELECT = `
  SELECT a.id, a.patient_id, (p.first_name || ' ' || p.last_name) AS patient_name,
         a.staff_id, u.full_name AS staff_name,
         a.reason, a.status, a.starts_at, a.ends_at
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN users u ON u.id = a.staff_id`;

function map(r: ApptRow) {
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patient_name,
    staffId: r.staff_id,
    staffName: r.staff_name,
    reason: r.reason,
    status: r.status,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
  };
}

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  async list(opts: { from?: string; to?: string; patientId?: string; status?: string }) {
    return this.tx(async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.from) {
        params.push(opts.from);
        where.push(`a.ends_at > $${params.length}`);
      }
      if (opts.to) {
        params.push(opts.to);
        where.push(`a.starts_at < $${params.length}`);
      }
      if (opts.patientId) {
        params.push(opts.patientId);
        where.push(`a.patient_id = $${params.length}`);
      }
      if (opts.status) {
        params.push(opts.status);
        where.push(`a.status = $${params.length}`);
      }
      const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY a.starts_at ASC LIMIT 500`;
      const { rows } = await client.query<ApptRow>(sql, params);
      return rows.map(map);
    });
  }

  async getById(id: string) {
    return this.tx(async (client) => {
      const { rows } = await client.query<ApptRow>(`${SELECT} WHERE a.id = $1`, [id]);
      if (!rows[0]) throw new NotFoundException('Appointment not found');
      return map(rows[0]);
    });
  }

  async create(dto: CreateAppointmentDto, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    this.assertTimes(dto.startsAt, dto.endsAt);
    return this.db.withTenant(tenantId, async (client) => {
      await this.assertPatient(client, dto.patientId);
      if (dto.staffId) await this.assertStaff(client, dto.staffId);
      await this.assertNoOverlap(client, dto.staffId ?? null, dto.startsAt, dto.endsAt, null);

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO appointments
           (tenant_id, patient_id, staff_id, reason, starts_at, ends_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [tenantId, dto.patientId, dto.staffId ?? null, dto.reason, dto.startsAt, dto.endsAt, userId],
      );
      const created = await client.query<ApptRow>(`${SELECT} WHERE a.id = $1`, [rows[0]!.id]);
      return map(created.rows[0]!);
    });
  }

  async update(id: string, dto: UpdateAppointmentDto) {
    return this.tx(async (client) => {
      const cur = await client.query<{
        patient_id: string;
        staff_id: string | null;
        starts_at: string;
        ends_at: string;
        status: string;
      }>(
        'SELECT patient_id, staff_id, starts_at, ends_at, status FROM appointments WHERE id = $1 FOR UPDATE',
        [id],
      );
      const existing = cur.rows[0];
      if (!existing) throw new NotFoundException('Appointment not found');

      const next = {
        patientId: dto.patientId ?? existing.patient_id,
        staffId: dto.staffId === undefined ? existing.staff_id : dto.staffId,
        startsAt: dto.startsAt ?? existing.starts_at,
        endsAt: dto.endsAt ?? existing.ends_at,
        status: dto.status ?? existing.status,
      };
      this.assertTimes(next.startsAt, next.endsAt);
      if (dto.patientId) await this.assertPatient(client, dto.patientId);
      if (dto.staffId) await this.assertStaff(client, dto.staffId);
      if (next.status === 'scheduled') {
        await this.assertNoOverlap(client, next.staffId, next.startsAt, next.endsAt, id);
      }

      await client.query(
        `UPDATE appointments
            SET patient_id = $1, staff_id = $2, starts_at = $3, ends_at = $4,
                reason = coalesce($5, reason), status = $6, updated_at = now()
          WHERE id = $7`,
        [next.patientId, next.staffId, next.startsAt, next.endsAt, dto.reason ?? null, next.status, id],
      );
      const updated = await client.query<ApptRow>(`${SELECT} WHERE a.id = $1`, [id]);
      return map(updated.rows[0]!);
    });
  }

  // ── helpers ──────────────────────────────────────────────
  private assertTimes(start: string, end: string) {
    if (new Date(end) <= new Date(start)) {
      throw new BadRequestException('End time must be after start time');
    }
  }

  private async assertPatient(client: PoolClient, patientId: string) {
    const r = await client.query('SELECT 1 FROM patients WHERE id = $1', [patientId]);
    if (!r.rowCount) throw new NotFoundException('Patient not found');
  }

  private async assertStaff(client: PoolClient, staffId: string) {
    const r = await client.query('SELECT 1 FROM users WHERE id = $1', [staffId]);
    if (!r.rowCount) throw new NotFoundException('Staff member not found');
  }

  /** A practitioner cannot have two overlapping scheduled appointments. */
  private async assertNoOverlap(
    client: PoolClient,
    staffId: string | null,
    start: string,
    end: string,
    excludeId: string | null,
  ) {
    if (!staffId) return;
    const r = await client.query(
      `SELECT 1 FROM appointments
        WHERE staff_id = $1 AND status = 'scheduled'
          AND tstzrange(starts_at, ends_at) && tstzrange($2::timestamptz, $3::timestamptz)
          AND ($4::uuid IS NULL OR id <> $4::uuid)
        LIMIT 1`,
      [staffId, start, end, excludeId],
    );
    if (r.rowCount) {
      throw new ConflictException('This practitioner already has an appointment in that time slot');
    }
  }
}
