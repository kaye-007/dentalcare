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
import { CreateLabOrderDto, MoveLabOrderDto, UpdateLabOrderDto } from './dto/lab.dto';
import { refusal, stampsAfter, type LabStatus } from './lab-status';

interface LabRow {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string | null;
  lab_id: string | null;
  lab_name: string | null;
  lab_phone: string | null;
  dentist_id: string | null;
  dentist_name: string | null;
  plan_item_id: string | null;
  plan_item_description: string | null;
  work: string;
  teeth: number[];
  material: string | null;
  shade: string | null;
  cost: number | null;
  due_on: string | null;
  status: LabStatus;
  notes: string | null;
  sent_at: string | null;
  received_at: string | null;
  fitted_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  overdue: boolean;
}

/** The clinic's today, on its own clock (0023). */
const TODAY = 'clinic_today()';

const SELECT = `
  SELECT o.id, o.patient_id, (p.first_name || ' ' || p.last_name) AS patient_name,
         p.phone AS patient_phone,
         o.lab_id, l.name AS lab_name, l.phone AS lab_phone,
         o.dentist_id, u.full_name AS dentist_name,
         o.plan_item_id, pi.description AS plan_item_description,
         o.work, o.teeth, o.material, o.shade, o.cost, o.due_on::text AS due_on,
         o.status, o.notes, o.sent_at, o.received_at, o.fitted_at,
         o.cancelled_at, o.cancel_reason, o.created_at,
         (o.status IN ('preparing', 'sent') AND o.due_on < ${TODAY}) AS overdue
    FROM lab_orders o
    JOIN patients p ON p.id = o.patient_id
    LEFT JOIN partners l ON l.id = o.lab_id
    LEFT JOIN users u ON u.id = o.dentist_id
    LEFT JOIN treatment_plan_items pi ON pi.id = o.plan_item_id`;

function map(r: LabRow) {
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patient_name,
    patientPhone: r.patient_phone,
    labId: r.lab_id,
    labName: r.lab_name,
    labPhone: r.lab_phone,
    dentistId: r.dentist_id,
    dentistName: r.dentist_name,
    planItemId: r.plan_item_id,
    planItemDescription: r.plan_item_description,
    work: r.work,
    teeth: (r.teeth ?? []).map(Number),
    material: r.material,
    shade: r.shade,
    cost: r.cost === null ? null : Number(r.cost),
    dueOn: r.due_on,
    status: r.status,
    notes: r.notes,
    sentAt: r.sent_at,
    receivedAt: r.received_at,
    fittedAt: r.fitted_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
    overdue: r.overdue,
  };
}

const STEP_WORDS: Record<LabStatus, string> = {
  preparing: 'back to preparing',
  sent: 'sent to the lab',
  received: 'received from the lab',
  fitted: 'fitted',
  cancelled: 'cancelled',
};

const teethOf = (teeth: number[] | undefined) =>
  teeth === undefined ? undefined : [...new Set(teeth)].sort((a, b) => a - b);
const text = (v: string | null | undefined) =>
  v === undefined ? undefined : v === null ? null : v.trim() || null;

/**
 * Lab work (0020): what the clinic has ordered from a dental laboratory, for
 * whom, and where it is. The rules of its life are in lab-status.ts; this
 * checks what it is given, writes it with its audit row, and reads it back
 * with the names a screen needs.
 */
@Injectable()
export class LabService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /**
   * `open` (the default): everything not yet fitted or cancelled, soonest due
   * first. `done`: the most recent fitted and cancelled. A patient's list is
   * everything, newest first.
   */
  list(opts: { scope?: string; patientId?: string }) {
    return this.tx(async (client) => {
      if (opts.patientId) {
        const { rows } = await client.query<LabRow>(
          `${SELECT} WHERE o.patient_id = $1 ORDER BY o.created_at DESC LIMIT 200`,
          [opts.patientId],
        );
        return rows.map(map);
      }
      if (opts.scope === 'done') {
        const { rows } = await client.query<LabRow>(
          `${SELECT} WHERE o.status IN ('fitted', 'cancelled')
            ORDER BY coalesce(o.fitted_at, o.cancelled_at) DESC LIMIT 100`,
        );
        return rows.map(map);
      }
      const { rows } = await client.query<LabRow>(
        `${SELECT} WHERE o.status IN ('preparing', 'sent', 'received')
          ORDER BY o.due_on ASC NULLS LAST, o.created_at ASC LIMIT 500`,
      );
      return rows.map(map);
    });
  }

  /** The numbers the dashboards ask for: what is late, what is back to fit. */
  summary() {
    return this.tx(async (client) => {
      const { rows } = await client.query<{
        open: number;
        overdue: number;
        ready: number;
        due_soon: number;
      }>(
        `SELECT count(*) FILTER (WHERE status IN ('preparing', 'sent', 'received'))::int AS open,
                count(*) FILTER (WHERE status IN ('preparing', 'sent')
                                   AND due_on < ${TODAY})::int AS overdue,
                count(*) FILTER (WHERE status = 'received')::int AS ready,
                count(*) FILTER (WHERE status IN ('preparing', 'sent')
                                   AND due_on BETWEEN ${TODAY} AND ${TODAY} + 2)::int AS due_soon
           FROM lab_orders`,
      );
      const r = rows[0]!;
      return { open: r.open, overdue: r.overdue, ready: r.ready, dueSoon: r.due_soon };
    });
  }

  async create(dto: CreateLabOrderDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rows: p } = await client.query<{ status: string }>(
        'SELECT status FROM patients WHERE id = $1',
        [dto.patientId],
      );
      if (!p[0]) throw new NotFoundException('Patient not found');
      if (p[0].status === 'archived') {
        throw new BadRequestException(
          'This patient is archived. Restore the record before ordering lab work.',
        );
      }
      await this.checkLinks(client, dto.patientId, dto);

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO lab_orders
           (tenant_id, patient_id, lab_id, dentist_id, plan_item_id, work, teeth,
            material, shade, cost, due_on, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          tenantId,
          dto.patientId,
          dto.labId ?? null,
          dto.dentistId ?? null,
          dto.planItemId ?? null,
          dto.work.trim(),
          teethOf(dto.teeth) ?? [],
          text(dto.material) ?? null,
          text(dto.shade) ?? null,
          dto.cost ?? null,
          dto.dueOn ?? null,
          text(dto.notes) ?? null,
          actor.userId,
        ],
      );
      const id = rows[0]!.id;
      await this.audit.record(client, actor, {
        action: 'lab.order_created',
        entityType: 'lab_order',
        entityId: id,
        summary: `Ordered lab work: ${dto.work.trim()}`,
        metadata: { patientId: dto.patientId },
      });
      return this.read(client, id);
    });
  }

  async update(id: string, dto: UpdateLabOrderDto, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const { rows: cur } = await client.query<{ patient_id: string; work: string }>(
        'SELECT patient_id, work FROM lab_orders WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!cur[0]) throw new NotFoundException('Lab work not found');
      await this.checkLinks(client, cur[0].patient_id, dto);

      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        if (value === undefined) return;
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      set('work', dto.work?.trim());
      set('teeth', teethOf(dto.teeth));
      set('lab_id', dto.labId);
      set('dentist_id', dto.dentistId);
      set('plan_item_id', dto.planItemId);
      set('material', text(dto.material));
      set('shade', text(dto.shade));
      set('cost', dto.cost);
      set('due_on', dto.dueOn);
      set('notes', text(dto.notes));
      if (sets.length > 0) {
        await client.query(
          `UPDATE lab_orders SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
          params,
        );
        await this.audit.record(client, actor, {
          action: 'lab.order_updated',
          entityType: 'lab_order',
          entityId: id,
          summary: `Updated lab work: ${dto.work?.trim() ?? cur[0].work}`,
          metadata: { fields: Object.keys(dto) },
        });
      }
      return this.read(client, id);
    });
  }

  /**
   * Move the work along its line (lab-status.ts decides what is allowed),
   * stamping when each step happened. Cancelling needs a reason; a cancelled
   * job comes back to the step its stamps reached.
   */
  async move(id: string, dto: MoveLabOrderDto, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const { rows: cur } = await client.query<{
        status: LabStatus;
        work: string;
        sent_at: Date | null;
        received_at: Date | null;
        fitted_at: Date | null;
      }>(
        `SELECT status, work, sent_at, received_at, fitted_at
           FROM lab_orders WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const c = cur[0];
      if (!c) throw new NotFoundException('Lab work not found');
      const stamps = {
        sentAt: c.sent_at,
        receivedAt: c.received_at,
        fittedAt: c.fitted_at,
      };
      const now = new Date();
      const why = refusal(c.status, dto.status, stamps, now);
      if (why) throw new ConflictException(why);

      if (dto.status === 'cancelled') {
        const reason = dto.reason?.trim();
        if (!reason) throw new BadRequestException('Say why the lab work is cancelled.');
        await client.query(
          `UPDATE lab_orders
              SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2,
                  updated_at = now()
            WHERE id = $1`,
          [id, reason],
        );
      } else if (c.status === 'cancelled') {
        await client.query(
          `UPDATE lab_orders
              SET status = $2, cancelled_at = NULL, cancel_reason = NULL, updated_at = now()
            WHERE id = $1`,
          [id, dto.status],
        );
      } else {
        const next = stampsAfter(dto.status, stamps, now);
        await client.query(
          `UPDATE lab_orders
              SET status = $2, sent_at = $3, received_at = $4, fitted_at = $5,
                  updated_at = now()
            WHERE id = $1`,
          [id, dto.status, next.sentAt, next.receivedAt, next.fittedAt],
        );
      }
      await this.audit.record(client, actor, {
        action: 'lab.order_moved',
        entityType: 'lab_order',
        entityId: id,
        summary: `Lab work ${STEP_WORDS[dto.status]}: ${c.work}`,
        metadata: { from: c.status, to: dto.status },
      });
      return this.read(client, id);
    });
  }

  /* ── helpers ───────────────────────────────────────────── */

  private async read(client: PoolClient, id: string) {
    const { rows } = await client.query<LabRow>(`${SELECT} WHERE o.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('Lab work not found');
    return map(rows[0]);
  }

  /** The lab, the dentist and the plan line must exist, and be this patient's. */
  private async checkLinks(
    client: PoolClient,
    patientId: string,
    dto: { labId?: string | null; dentistId?: string | null; planItemId?: string | null },
  ) {
    if (dto.labId) {
      const { rows } = await client.query<{ is_active: boolean }>(
        `SELECT is_active FROM partners WHERE id = $1 AND kind = 'lab'`,
        [dto.labId],
      );
      if (!rows[0]) throw new NotFoundException('That lab is not on the clinic’s list');
      if (!rows[0].is_active) throw new BadRequestException('That lab has been retired');
    }
    if (dto.dentistId) {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM users WHERE id = $1',
        [dto.dentistId],
      );
      if (!rows[0]) throw new NotFoundException('Dentist not found');
      if (rows[0].status !== 'active') {
        throw new BadRequestException('That staff account is disabled');
      }
    }
    if (dto.planItemId) {
      const { rows } = await client.query(
        `SELECT 1 FROM treatment_plan_items pi
           JOIN treatment_plans tp ON tp.id = pi.plan_id
          WHERE pi.id = $1 AND tp.patient_id = $2`,
        [dto.planItemId, patientId],
      );
      if (!rows[0]) {
        throw new BadRequestException('That treatment plan line is not this patient’s');
      }
    }
  }
}
