import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { type Surface, isValidSurface, surfacesFor } from '@/modules/clinic/charting';
import {
  PLAN_TIMESTAMP_COLUMN,
  type PlanLineInput,
  type PlanStatus,
  calculateLine,
  calculatePlan,
  canTransitionPlan,
  explainPlanRefusal,
  allowedPlanTransitions,
} from './cost-engine';
import {
  CreatePlanDto,
  CreatePlanItemDto,
  TransitionPlanDto,
  UpdatePlanDto,
  UpdatePlanItemDto,
} from './dto/treatment-plans.dto';

/* ═════════════════════════ service ═════════════════════════ */

interface PlanRow {
  id: string;
  patient_id: string;
  patient_name: string;
  title: string;
  status: PlanStatus;
  note: string | null;
  discount_amount: number;
  proposed_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  completed_at: string | null;
  dentist_id: string | null;
  dentist_name: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  tooth: number | null;
  surfaces: string[];
  procedure_code_id: string | null;
  code: string | null;
  code_system: string | null;
  treatment_id: string | null;
  description: string;
  quantity: number;
  unit_fee: number;
  discount_amount: number;
  status: 'planned' | 'scheduled' | 'completed' | 'cancelled';
  sort_order: number;
  note: string | null;
}

const PLAN_SELECT = `
  SELECT p.id, p.patient_id, (pa.first_name || ' ' || pa.last_name) AS patient_name,
         p.title, p.status, p.note, p.discount_amount,
         p.proposed_at, p.accepted_at, p.declined_at, p.decline_reason, p.completed_at,
         p.dentist_id, u.full_name AS dentist_name, p.created_at, p.updated_at
    FROM treatment_plans p
    JOIN patients pa ON pa.id = p.patient_id
    LEFT JOIN users u ON u.id = p.dentist_id`;

const ITEM_SELECT = `
  SELECT i.id, i.tooth, i.surfaces, i.procedure_code_id,
         c.code, c.system AS code_system, i.treatment_id,
         i.description, i.quantity, i.unit_fee, i.discount_amount,
         i.status, i.sort_order, i.note
    FROM treatment_plan_items i
    LEFT JOIN procedure_codes c ON c.id = i.procedure_code_id`;

const mapItem = (r: ItemRow) => {
  const cost = calculateLine({
    unitFee: r.unit_fee,
    quantity: r.quantity,
    discountAmount: r.discount_amount,
    status: r.status,
  });
  return {
    id: r.id,
    tooth: r.tooth,
    surfaces: (r.surfaces ?? []) as Surface[],
    procedureCodeId: r.procedure_code_id,
    code: r.code,
    codeSystem: r.code_system,
    treatmentId: r.treatment_id,
    description: r.description,
    quantity: r.quantity,
    unitFee: r.unit_fee,
    discountAmount: r.discount_amount,
    status: r.status,
    sortOrder: r.sort_order,
    note: r.note,
    // Costs are computed, never stored — see the engine's header.
    subtotal: cost.subtotal,
    total: cost.total,
  };
};

@Injectable()
export class TreatmentPlansService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  private async itemsOf(client: PoolClient, planId: string) {
    const { rows } = await client.query<ItemRow>(
      `${ITEM_SELECT} WHERE i.plan_id = $1 ORDER BY i.sort_order, i.created_at`,
      [planId],
    );
    return rows.map(mapItem);
  }

  private toLineInputs(items: ReturnType<typeof mapItem>[]): PlanLineInput[] {
    return items.map((i) => ({
      unitFee: i.unitFee,
      quantity: i.quantity,
      discountAmount: i.discountAmount,
      status: i.status,
    }));
  }

  private shape(plan: PlanRow, items: ReturnType<typeof mapItem>[]) {
    return {
      id: plan.id,
      patientId: plan.patient_id,
      patientName: plan.patient_name,
      title: plan.title,
      status: plan.status,
      note: plan.note,
      discountAmount: plan.discount_amount,
      proposedAt: plan.proposed_at,
      acceptedAt: plan.accepted_at,
      declinedAt: plan.declined_at,
      declineReason: plan.decline_reason,
      completedAt: plan.completed_at,
      dentistId: plan.dentist_id,
      dentistName: plan.dentist_name,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
      items,
      cost: calculatePlan(this.toLineInputs(items), plan.discount_amount),
      allowedTransitions: allowedPlanTransitions(plan.status),
    };
  }

  async listForPatient(patientId: string, status?: PlanStatus) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM patients WHERE id = $1', [
        patientId,
      ]);
      if (!rowCount) throw new NotFoundException('Patient not found');

      const params: unknown[] = [patientId];
      let filter = '';
      if (status) {
        params.push(status);
        filter = ` AND p.status = $${params.length}`;
      }
      const { rows } = await client.query<PlanRow>(
        `${PLAN_SELECT} WHERE p.patient_id = $1${filter} ORDER BY p.created_at DESC`,
        params,
      );
      // One query per plan for items keeps each plan's costing exact; plans per
      // patient are a handful, not a page of results.
      return Promise.all(
        rows.map(async (p) => this.shape(p, await this.itemsOf(client, p.id))),
      );
    });
  }

  async getById(id: string) {
    return this.tx(async (client) => {
      const { rows } = await client.query<PlanRow>(`${PLAN_SELECT} WHERE p.id = $1`, [
        id,
      ]);
      if (!rows[0]) throw new NotFoundException('Treatment plan not found');
      return this.shape(rows[0], await this.itemsOf(client, id));
    });
  }

  async create(patientId: string, dto: CreatePlanDto, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rows: patient } = await client.query<{ status: string }>(
        'SELECT status FROM patients WHERE id = $1',
        [patientId],
      );
      if (!patient[0]) throw new NotFoundException('Patient not found');
      if (patient[0].status === 'archived') {
        throw new BadRequestException(
          'This patient is archived. Restore the record before planning treatment.',
        );
      }

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO treatment_plans
           (tenant_id, patient_id, title, note, dentist_id, discount_amount, created_by)
         VALUES ($1,$2,btrim($3),$4,$5,$6,$7) RETURNING id`,
        [
          tenantId,
          patientId,
          dto.title,
          dto.note ?? null,
          dto.dentistId ?? null,
          dto.discountAmount ?? 0,
          userId,
        ],
      );
      const { rows: full } = await client.query<PlanRow>(
        `${PLAN_SELECT} WHERE p.id = $1`,
        [rows[0].id],
      );
      return this.shape(full[0], []);
    });
  }

  async update(id: string, dto: UpdatePlanDto) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (frag: string, v: unknown) => {
      params.push(v);
      sets.push(frag.replace('$$', `$${params.length}`));
    };
    if (dto.title !== undefined) push('title = btrim($$)', dto.title);
    if (dto.note !== undefined) push('note = $$', dto.note || null);
    if (dto.dentistId !== undefined) push('dentist_id = $$', dto.dentistId ?? null);
    if (dto.discountAmount !== undefined)
      push('discount_amount = $$', dto.discountAmount);
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      const { rows: cur } = await client.query<{ status: PlanStatus }>(
        'SELECT status FROM treatment_plans WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!cur[0]) throw new NotFoundException('Treatment plan not found');
      if (cur[0].status === 'completed') {
        throw new ConflictException('A completed plan cannot be edited.');
      }

      await client.query(
        `UPDATE treatment_plans SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
        params,
      );
      const { rows: full } = await client.query<PlanRow>(
        `${PLAN_SELECT} WHERE p.id = $1`,
        [id],
      );
      return this.shape(full[0], await this.itemsOf(client, id));
    });
  }

  async transition(id: string, dto: TransitionPlanDto) {
    return this.tx(async (client) => {
      const { rows: cur } = await client.query<{ status: PlanStatus }>(
        'SELECT status FROM treatment_plans WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!cur[0]) throw new NotFoundException('Treatment plan not found');
      const from = cur[0].status;
      const to = dto.status;

      if (!canTransitionPlan(from, to)) {
        throw new ConflictException(explainPlanRefusal(from, to));
      }
      if (to === 'declined' && !dto.reason?.trim()) {
        throw new BadRequestException('Record why the patient declined the plan');
      }
      if (to === 'proposed') {
        const { rows: count } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM treatment_plan_items
            WHERE plan_id = $1 AND status <> 'cancelled'`,
          [id],
        );
        if (Number(count[0].n) === 0) {
          throw new BadRequestException(
            'Add at least one procedure before proposing the plan to the patient.',
          );
        }
      }

      const params: unknown[] = [id, to];
      const sets = ['status = $2', 'updated_at = now()'];
      const stamp = PLAN_TIMESTAMP_COLUMN[to];
      if (stamp) sets.push(`${stamp} = now()`);
      // Leaving a state clears its milestone, so the schema's consistency
      // constraints hold in both directions.
      if (to !== 'declined') sets.push('declined_at = NULL', 'decline_reason = NULL');
      if (to === 'draft') sets.push('proposed_at = NULL', 'accepted_at = NULL');
      if (to === 'declined') {
        params.push(dto.reason!.trim());
        sets.push(`decline_reason = $${params.length}`);
      }

      await client.query(
        `UPDATE treatment_plans SET ${sets.join(', ')} WHERE id = $1`,
        params,
      );
      const { rows: full } = await client.query<PlanRow>(
        `${PLAN_SELECT} WHERE p.id = $1`,
        [id],
      );
      return this.shape(full[0], await this.itemsOf(client, id));
    });
  }

  async remove(id: string) {
    return this.tx(async (client) => {
      const { rows } = await client.query<{ status: PlanStatus }>(
        'SELECT status FROM treatment_plans WHERE id = $1',
        [id],
      );
      if (!rows[0]) throw new NotFoundException('Treatment plan not found');
      // An accepted plan is an agreement with the patient and part of the
      // clinical record; decline it rather than erasing that it existed.
      if (['accepted', 'in_progress', 'completed'].includes(rows[0].status)) {
        throw new ConflictException(
          'This plan was accepted by the patient and cannot be deleted. Decline it instead.',
        );
      }
      await client.query('DELETE FROM treatment_plans WHERE id = $1', [id]);
      return { deleted: true as const };
    });
  }

  /* ── line items ── */

  private validateItem(dto: CreatePlanItemDto | UpdatePlanItemDto) {
    const surfaces = dto.surfaces ?? [];
    if (surfaces.length && dto.tooth === undefined) {
      throw new BadRequestException('Surfaces require a tooth');
    }
    for (const s of surfaces) {
      if (!isValidSurface(dto.tooth!, s)) {
        throw new BadRequestException(
          `Tooth ${dto.tooth} has no ${s} surface. Valid surfaces: ${surfacesFor(dto.tooth!).join(', ')}.`,
        );
      }
    }
    const qty = dto.quantity ?? 1;
    const fee = dto.unitFee ?? 0;
    if ((dto.discountAmount ?? 0) > fee * qty) {
      throw new BadRequestException(
        'The discount cannot be larger than the line it applies to.',
      );
    }
  }

  async addItem(planId: string, dto: CreatePlanItemDto) {
    this.validateItem(dto);
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rows: plan } = await client.query<{ status: PlanStatus }>(
        'SELECT status FROM treatment_plans WHERE id = $1 FOR UPDATE',
        [planId],
      );
      if (!plan[0]) throw new NotFoundException('Treatment plan not found');
      if (plan[0].status === 'completed') {
        throw new ConflictException('A completed plan cannot be changed.');
      }

      // Default the fee from the code catalogue so a clinic that maintains
      // prices in one place does not retype them per plan.
      let unitFee = dto.unitFee;
      if (unitFee === undefined && dto.procedureCodeId) {
        const { rows } = await client.query<{ default_fee: number }>(
          'SELECT default_fee FROM procedure_codes WHERE id = $1',
          [dto.procedureCodeId],
        );
        unitFee = rows[0]?.default_fee;
      }
      if (unitFee === undefined && dto.treatmentId) {
        const { rows } = await client.query<{ price: number }>(
          'SELECT price FROM treatments WHERE id = $1',
          [dto.treatmentId],
        );
        unitFee = rows[0]?.price;
      }

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO treatment_plan_items
           (tenant_id, plan_id, tooth, surfaces, procedure_code_id, treatment_id,
            description, quantity, unit_fee, discount_amount, sort_order, note)
         VALUES ($1,$2,$3,$4,$5,$6,btrim($7),$8,$9,$10,
                 coalesce($11, (SELECT coalesce(max(sort_order),0)+1
                                  FROM treatment_plan_items WHERE plan_id = $2)),
                 $12)
         RETURNING id`,
        [
          tenantId,
          planId,
          dto.tooth ?? null,
          dto.surfaces ?? [],
          dto.procedureCodeId ?? null,
          dto.treatmentId ?? null,
          dto.description,
          dto.quantity ?? 1,
          unitFee ?? 0,
          dto.discountAmount ?? 0,
          dto.sortOrder ?? null,
          dto.note ?? null,
        ],
      );
      await client.query('UPDATE treatment_plans SET updated_at = now() WHERE id = $1', [
        planId,
      ]);
      const { rows: item } = await client.query<ItemRow>(
        `${ITEM_SELECT} WHERE i.id = $1`,
        [rows[0].id],
      );
      return mapItem(item[0]);
    });
  }

  async updateItem(itemId: string, dto: UpdatePlanItemDto) {
    this.validateItem(dto);
    const sets: string[] = [];
    const params: unknown[] = [itemId];
    const push = (frag: string, v: unknown) => {
      params.push(v);
      sets.push(frag.replace('$$', `$${params.length}`));
    };
    if (dto.tooth !== undefined) push('tooth = $$', dto.tooth ?? null);
    if (dto.surfaces !== undefined) push('surfaces = $$', dto.surfaces);
    if (dto.procedureCodeId !== undefined)
      push('procedure_code_id = $$', dto.procedureCodeId ?? null);
    if (dto.treatmentId !== undefined) push('treatment_id = $$', dto.treatmentId ?? null);
    if (dto.description !== undefined) push('description = btrim($$)', dto.description);
    if (dto.quantity !== undefined) push('quantity = $$', dto.quantity);
    if (dto.unitFee !== undefined) push('unit_fee = $$', dto.unitFee);
    if (dto.discountAmount !== undefined)
      push('discount_amount = $$', dto.discountAmount);
    if (dto.sortOrder !== undefined) push('sort_order = $$', dto.sortOrder);
    if (dto.status !== undefined) push('status = $$', dto.status);
    if (dto.note !== undefined) push('note = $$', dto.note || null);
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      try {
        const { rows } = await client.query<{ plan_id: string }>(
          `UPDATE treatment_plan_items SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1 RETURNING plan_id`,
          params,
        );
        if (!rows[0]) throw new NotFoundException('Plan item not found');
        await client.query(
          'UPDATE treatment_plans SET updated_at = now() WHERE id = $1',
          [rows[0].plan_id],
        );
        const { rows: item } = await client.query<ItemRow>(
          `${ITEM_SELECT} WHERE i.id = $1`,
          [itemId],
        );
        return mapItem(item[0]);
      } catch (err) {
        if ((err as { code?: string }).code === '23514') {
          throw new BadRequestException(
            'Those values are not valid: check the quantity, fee and discount.',
          );
        }
        throw err;
      }
    });
  }

  async removeItem(itemId: string) {
    return this.tx(async (client) => {
      const { rows } = await client.query<{ plan_id: string }>(
        'DELETE FROM treatment_plan_items WHERE id = $1 RETURNING plan_id',
        [itemId],
      );
      if (!rows[0]) throw new NotFoundException('Plan item not found');
      await client.query('UPDATE treatment_plans SET updated_at = now() WHERE id = $1', [
        rows[0].plan_id,
      ]);
      return { deleted: true as const };
    });
  }
}
