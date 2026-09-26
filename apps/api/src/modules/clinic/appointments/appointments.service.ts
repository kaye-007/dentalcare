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
  CreateAppointmentDto,
  UpdateAppointmentDto,
  TransitionStatusDto,
} from './dto/appointment.dto';
import {
  AppointmentStatus,
  BLOCKING_STATUSES,
  TIMESTAMP_COLUMN,
  canTransition,
  explainRefusal,
  isStatus,
} from './status-machine';
import { AppointmentEvents } from './appointment-events';
import { closureOn } from '@/modules/clinic/settings/closures.service';

/** Postgres error codes translated into user-facing messages. */
const EXCLUSION_VIOLATION = '23P01';
const FK_VIOLATION = '23503';

/** Constraint name → what the clinic actually needs to hear. */
const CONFLICT_MESSAGES: Record<string, string> = {
  appointment_no_staff_overlap:
    'That practitioner is already booked during this time.',
  appointment_no_operatory_overlap:
    'That room is already in use during this time.',
  appointment_no_patient_overlap:
    'This patient already has another appointment during this time.',
};

interface ApptRow {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string | null;
  patient_email: string | null;
  staff_id: string | null;
  staff_name: string | null;
  operatory_id: string | null;
  operatory_name: string | null;
  operatory_color: string | null;
  reason: string;
  status: AppointmentStatus;
  starts_at: string;
  ends_at: string;
  checked_in_at: string | null;
  in_progress_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  rescheduled_at: string | null;
}

const SELECT = `
  SELECT a.id, a.patient_id, (p.first_name || ' ' || p.last_name) AS patient_name,
         p.phone AS patient_phone, p.email AS patient_email,
         a.staff_id, u.full_name AS staff_name,
         a.operatory_id, o.name AS operatory_name, o.color AS operatory_color,
         a.reason, a.status, a.starts_at, a.ends_at,
         a.checked_in_at, a.in_progress_at, a.completed_at,
         a.cancelled_at, a.cancel_reason, a.rescheduled_at
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN users u ON u.id = a.staff_id
    LEFT JOIN operatories o ON o.id = a.operatory_id`;

function map(r: ApptRow) {
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patient_name,
    patientPhone: r.patient_phone,
    patientEmail: r.patient_email,
    staffId: r.staff_id,
    staffName: r.staff_name,
    operatoryId: r.operatory_id,
    operatoryName: r.operatory_name,
    operatoryColor: r.operatory_color,
    reason: r.reason,
    status: r.status,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    checkedInAt: r.checked_in_at,
    inProgressAt: r.in_progress_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    rescheduledAt: r.rescheduled_at,
  };
}

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly events: AppointmentEvents,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /**
   * Translate a database conflict into a sentence the front desk can act on.
   * The EXCLUDE constraints are the authority on what conflicts; this only
   * names which one fired.
   */
  private rethrowConflict(err: unknown): never {
    const e = err as { code?: string; constraint?: string };
    if (e.code === EXCLUSION_VIOLATION) {
      throw new ConflictException(
        CONFLICT_MESSAGES[e.constraint ?? ''] ?? 'That time slot is already taken.',
      );
    }
    if (e.code === FK_VIOLATION) {
      throw new BadRequestException(
        'The patient, practitioner or room referenced does not exist.',
      );
    }
    throw err as Error;
  }

  /* ── reads ─────────────────────────────────────────────── */

  async list(opts: {
    from?: string;
    to?: string;
    patientId?: string;
    staffId?: string;
    operatoryId?: string;
    /** Repeatable: ?status=scheduled&status=checked_in */
    status?: string[];
    limit?: number;
  }) {
    return this.tx(async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (frag: string, value: unknown) => {
        params.push(value);
        where.push(frag.replace('$$', `$${params.length}`));
      };

      // Half-open overlap: in range if it starts before the window ends and
      // ends after the window starts.
      if (opts.from) add('a.ends_at > $$', opts.from);
      if (opts.to) add('a.starts_at < $$', opts.to);
      if (opts.patientId) add('a.patient_id = $$', opts.patientId);
      if (opts.staffId) add('a.staff_id = $$', opts.staffId);
      if (opts.operatoryId) add('a.operatory_id = $$', opts.operatoryId);
      if (opts.status?.length) add('a.status = ANY($$)', opts.status);

      params.push(Math.min(2000, Math.max(1, opts.limit ?? 1000)));
      const { rows } = await client.query<ApptRow>(
        `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY a.starts_at ASC LIMIT $${params.length}`,
        params,
      );
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

  /** Full transition history, newest first. */
  async history(id: string) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM appointments WHERE id = $1', [id]);
      if (!rowCount) throw new NotFoundException('Appointment not found');
      const { rows } = await client.query<{
        id: string; from_status: string | null; to_status: string;
        note: string | null; actor_name: string | null; created_at: string;
      }>(
        `SELECT e.id, e.from_status, e.to_status, e.note,
                u.full_name AS actor_name, e.created_at
           FROM appointment_status_events e
           LEFT JOIN users u ON u.id = e.actor_id
          WHERE e.appointment_id = $1
          ORDER BY e.created_at DESC`,
        [id],
      );
      return rows.map((r) => ({
        id: r.id,
        fromStatus: r.from_status,
        toStatus: r.to_status,
        note: r.note,
        actorName: r.actor_name,
        createdAt: r.created_at,
      }));
    });
  }

  /* ── writes ────────────────────────────────────────────── */

  async create(dto: CreateAppointmentDto, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    this.assertTimes(dto.startsAt, dto.endsAt);
    return this.db.withTenant(tenantId, async (client) => {
      await this.assertPatient(client, dto.patientId);
      if (dto.staffId) await this.assertStaff(client, dto.staffId);
      if (dto.operatoryId) await this.assertOperatory(client, dto.operatoryId);

      let id: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO appointments
             (tenant_id, patient_id, staff_id, operatory_id, reason,
              starts_at, ends_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            tenantId, dto.patientId, dto.staffId ?? null, dto.operatoryId ?? null,
            dto.reason, dto.startsAt, dto.endsAt, userId,
          ],
        );
        id = rows[0].id;
      } catch (err) {
        this.rethrowConflict(err);
      }

      await this.recordEvent(client, tenantId, id, null, 'scheduled', null, userId);
      const { rows: full } = await client.query<ApptRow>(`${SELECT} WHERE a.id = $1`, [id]);
      const appointment = map(full[0]);
      await this.events.emit({ type: 'appointment.created', appointment, actorId: userId });
      return appointment;
    });
  }

  /**
   * Edit details or move the appointment. Status is deliberately NOT settable
   * here — lifecycle changes go through `transition`, which enforces the state
   * machine and writes an audit row. Allowing both paths would mean two places
   * that can set status and only one that records why.
   */
  async update(id: string, dto: UpdateAppointmentDto, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rows: cur } = await client.query<{
        patient_id: string; staff_id: string | null; operatory_id: string | null;
        starts_at: string; ends_at: string; status: AppointmentStatus;
      }>(
        `SELECT patient_id, staff_id, operatory_id, starts_at, ends_at, status
           FROM appointments WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const existing = cur[0];
      if (!existing) throw new NotFoundException('Appointment not found');
      if (existing.status === 'completed') {
        throw new ConflictException(
          'A completed appointment cannot be edited. Create a new appointment instead.',
        );
      }

      const next = {
        patientId: dto.patientId ?? existing.patient_id,
        staffId: dto.staffId === undefined ? existing.staff_id : dto.staffId,
        operatoryId:
          dto.operatoryId === undefined ? existing.operatory_id : dto.operatoryId,
        startsAt: dto.startsAt ?? existing.starts_at,
        endsAt: dto.endsAt ?? existing.ends_at,
      };
      this.assertTimes(next.startsAt, next.endsAt);
      if (dto.patientId) await this.assertPatient(client, dto.patientId);
      if (dto.staffId) await this.assertStaff(client, dto.staffId);
      if (dto.operatoryId) await this.assertOperatory(client, dto.operatoryId);

      const moved =
        new Date(next.startsAt).getTime() !== new Date(existing.starts_at).getTime() ||
        new Date(next.endsAt).getTime() !== new Date(existing.ends_at).getTime();

      try {
        await client.query(
          `UPDATE appointments
              SET patient_id = $1, staff_id = $2, operatory_id = $3,
                  starts_at = $4, ends_at = $5,
                  reason = coalesce($6, reason),
                  rescheduled_at = CASE WHEN $7 THEN now() ELSE rescheduled_at END,
                  updated_at = now()
            WHERE id = $8`,
          [
            next.patientId, next.staffId, next.operatoryId,
            next.startsAt, next.endsAt, dto.reason ?? null, moved, id,
          ],
        );
      } catch (err) {
        this.rethrowConflict(err);
      }

      const { rows: full } = await client.query<ApptRow>(`${SELECT} WHERE a.id = $1`, [id]);
      const appointment = map(full[0]);
      await this.events.emit(
        moved
          ? {
              type: 'appointment.rescheduled',
              appointment,
              actorId: userId,
              previous: { startsAt: existing.starts_at, endsAt: existing.ends_at },
            }
          : { type: 'appointment.updated', appointment, actorId: userId },
      );
      return appointment;
    });
  }

  /**
   * Move the appointment through its lifecycle. The state machine decides what
   * is legal; the database decides whether the slot is still free — reinstating
   * a cancelled appointment can collide with whatever was booked meanwhile.
   */
  async transition(id: string, dto: TransitionStatusDto, userId: string) {
    const to = dto.status;
    if (!isStatus(to)) throw new BadRequestException('Unknown status');

    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rows: cur } = await client.query<{ status: AppointmentStatus }>(
        'SELECT status FROM appointments WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!cur[0]) throw new NotFoundException('Appointment not found');
      const from = cur[0].status;

      if (!canTransition(from, to)) {
        throw new ConflictException(explainRefusal(from, to));
      }
      if (to === 'cancelled' && !dto.reason?.trim()) {
        throw new BadRequestException('A cancellation reason is required');
      }

      // Stamp the state being entered and clear the ones being left, so the
      // completed/cancelled CHECK constraints hold in both directions.
      const params: unknown[] = [id, to];
      const sets = ['status = $2', 'updated_at = now()'];
      const stamp = TIMESTAMP_COLUMN[to];
      if (stamp) sets.push(`${stamp} = now()`);
      if (to !== 'completed') sets.push('completed_at = NULL');
      if (to !== 'cancelled') sets.push('cancelled_at = NULL', 'cancel_reason = NULL');
      if (to === 'scheduled') {
        // Reinstated: the visit has not happened, so clear progress markers.
        sets.push('checked_in_at = NULL', 'in_progress_at = NULL');
      }
      if (to === 'cancelled') {
        params.push(dto.reason!.trim());
        sets.push(`cancel_reason = $${params.length}`);
      }

      try {
        await client.query(`UPDATE appointments SET ${sets.join(', ')} WHERE id = $1`, params);
      } catch (err) {
        this.rethrowConflict(err);
      }

      await this.recordEvent(
        client, tenantId, id, from, to, dto.reason?.trim() || dto.note?.trim() || null, userId,
      );

      const { rows: full } = await client.query<ApptRow>(`${SELECT} WHERE a.id = $1`, [id]);
      const appointment = map(full[0]);
      await this.events.emit({
        type: 'appointment.status_changed',
        appointment,
        actorId: userId,
        from,
        to,
      });
      return appointment;
    });
  }

  /**
   * Free slots for a practitioner on one day: their weekly availability minus
   * everything currently blocking. Availability is stored as clinic-local wall
   * time, so slots are built on the requested calendar date and returned as
   * instants.
   */
  async freeSlots(opts: {
    staffId: string;
    date: string;
    durationMinutes: number;
    operatoryId?: string;
  }) {
    const { staffId, date, durationMinutes } = opts;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('Date must be YYYY-MM-DD');
    }
    if (durationMinutes < 5 || durationMinutes > 480) {
      throw new BadRequestException('Duration must be between 5 and 480 minutes');
    }
    const day = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(day.getTime())) throw new BadRequestException('Invalid date');
    const weekday = day.getUTCDay();

    return this.tx(async (client) => {
      // A holiday or a day off wins over the weekly pattern.
      const closure = await closureOn(client, staffId, date);
      if (closure) {
        return {
          date,
          weekday,
          slots: [],
          reason: 'closed' as const,
          closure: closure.reason,
          wholeClinic: closure.wholeClinic,
        };
      }

      const { rows: shifts } = await client.query<{ starts_at: string; ends_at: string }>(
        `SELECT starts_at::text AS starts_at, ends_at::text AS ends_at
           FROM staff_availability
          WHERE staff_id = $1 AND weekday = $2
          ORDER BY starts_at`,
        [staffId, weekday],
      );
      if (!shifts.length) {
        return { date, weekday, slots: [], reason: 'not_working' as const };
      }

      const params: unknown[] = [staffId, BLOCKING_STATUSES, date];
      let who = 'a.staff_id = $1';
      if (opts.operatoryId) {
        params.push(opts.operatoryId);
        who = `(a.staff_id = $1 OR a.operatory_id = $${params.length})`;
      }
      const { rows: busy } = await client.query<{ starts_at: string; ends_at: string }>(
        `SELECT a.starts_at, a.ends_at FROM appointments a
          WHERE ${who} AND a.status = ANY($2)
            AND a.starts_at < ($3::date + interval '1 day')
            AND a.ends_at > $3::date`,
        params,
      );

      const taken = busy.map((b) => ({
        start: new Date(b.starts_at).getTime(),
        end: new Date(b.ends_at).getTime(),
      }));
      const stepMs = durationMinutes * 60_000;
      const slots: { startsAt: string; endsAt: string }[] = [];

      for (const shift of shifts) {
        let cursor = new Date(`${date}T${shift.starts_at}Z`).getTime();
        const shiftEnd = new Date(`${date}T${shift.ends_at}Z`).getTime();
        while (cursor + stepMs <= shiftEnd) {
          const end = cursor + stepMs;
          if (!taken.some((t) => cursor < t.end && end > t.start)) {
            slots.push({
              startsAt: new Date(cursor).toISOString(),
              endsAt: new Date(end).toISOString(),
            });
          }
          cursor += stepMs;
        }
      }
      return { date, weekday, slots, reason: null };
    });
  }

  /* ── helpers ───────────────────────────────────────────── */

  private async recordEvent(
    client: PoolClient,
    tenantId: string,
    appointmentId: string,
    from: AppointmentStatus | null,
    to: AppointmentStatus,
    note: string | null,
    actorId: string,
  ) {
    await client.query(
      `INSERT INTO appointment_status_events
         (tenant_id, appointment_id, from_status, to_status, note, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, appointmentId, from, to, note, actorId],
    );
  }

  private assertTimes(start: string, end: string) {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (Number.isNaN(s) || Number.isNaN(e)) {
      throw new BadRequestException('Invalid start or end time');
    }
    if (e <= s) throw new BadRequestException('End time must be after start time');
    if (e - s > 8 * 60 * 60_000) {
      throw new BadRequestException('An appointment cannot be longer than 8 hours');
    }
  }

  private async assertPatient(client: PoolClient, patientId: string) {
    const r = await client.query<{ status: string }>(
      'SELECT status FROM patients WHERE id = $1',
      [patientId],
    );
    if (!r.rowCount) throw new NotFoundException('Patient not found');
    if (r.rows[0].status === 'archived') {
      throw new BadRequestException(
        'This patient is archived. Restore the record before booking.',
      );
    }
  }

  private async assertStaff(client: PoolClient, staffId: string) {
    const r = await client.query<{ status: string }>(
      'SELECT status FROM users WHERE id = $1',
      [staffId],
    );
    if (!r.rowCount) throw new NotFoundException('Staff member not found');
    if (r.rows[0].status !== 'active') {
      throw new BadRequestException('That staff account is disabled');
    }
  }

  private async assertOperatory(client: PoolClient, operatoryId: string) {
    const r = await client.query<{ is_active: boolean }>(
      'SELECT is_active FROM operatories WHERE id = $1',
      [operatoryId],
    );
    if (!r.rowCount) throw new NotFoundException('Room not found');
    if (!r.rows[0].is_active) {
      throw new BadRequestException('That room is no longer in service');
    }
  }
}
