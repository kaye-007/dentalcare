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
  type Surface,
  type ToothCondition,
  isAbsent,
  isValidSurface,
  isValidTooth,
  isWholeToothCondition,
  surfacesFor,
  toothLabel,
} from '@dentalcare/shared';
import {
  CreateProcedureCodeDto,
  CreateProcedureDto,
  CreateToothConditionDto,
  UpdateProcedureCodeDto,
  UpdateProcedureDto,
  UpdateToothConditionDto,
} from './dto/charting.dto';

/**
 * The odontogram, the clinic's code catalogue, and the log of what was done.
 *
 * The database enforces anatomy (a molar has no incisal edge) and uniqueness
 * of active findings. This layer enforces the rules that need context the
 * schema cannot see — chiefly that you cannot chart a new finding on a tooth
 * already recorded as extracted.
 */

const UNIQUE_VIOLATION = '23505';

const CHECK_VIOLATION = '23514';

/* ═════════════════════════ service ═════════════════════════ */

export interface ConditionRow {
  id: string;
  tooth: number;
  surface: Surface | null;
  condition: ToothCondition;
  status: 'active' | 'treated' | 'resolved';
  note: string | null;
  dentist_id: string | null;
  dentist_name: string | null;
  resolved_by_procedure_id: string | null;
  recorded_at: string;
  updated_at: string;
}

const COND_SELECT = `
  SELECT c.id, c.tooth, c.surface, c.condition, c.status, c.note,
         c.dentist_id, u.full_name AS dentist_name,
         c.resolved_by_procedure_id, c.recorded_at, c.updated_at
    FROM tooth_conditions c
    LEFT JOIN users u ON u.id = c.dentist_id`;

const mapCondition = (r: ConditionRow) => ({
  id: r.id,
  tooth: r.tooth,
  surface: r.surface,
  condition: r.condition,
  status: r.status,
  note: r.note,
  dentistId: r.dentist_id,
  dentistName: r.dentist_name,
  resolvedByProcedureId: r.resolved_by_procedure_id,
  recordedAt: r.recorded_at,
  updatedAt: r.updated_at,
});

@Injectable()
export class ChartingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  private async assertPatient(client: PoolClient, patientId: string) {
    const r = await client.query('SELECT 1 FROM patients WHERE id = $1', [patientId]);
    if (!r.rowCount) throw new NotFoundException('Patient not found');
  }

  /* ── odontogram ── */

  /**
   * The whole chart in one call. Returns every finding plus a per-tooth
   * summary, so the SVG can colour teeth without the browser recomputing
   * what the server already knows.
   */
  async chart(patientId: string) {
    return this.tx(async (client) => {
      await this.assertPatient(client, patientId);
      const { rows } = await client.query<ConditionRow>(
        `${COND_SELECT} WHERE c.patient_id = $1
          ORDER BY c.tooth, c.surface NULLS FIRST, c.recorded_at DESC`,
        [patientId],
      );
      const conditions = rows.map(mapCondition);

      // Per-tooth roll-up: what a clinician needs to see at a glance.
      const byTooth = new Map<
        number,
        {
          tooth: number;
          conditions: ReturnType<typeof mapCondition>[];
          activeConditions: ToothCondition[];
          surfaces: Partial<Record<Surface, ToothCondition[]>>;
          isAbsent: boolean;
        }
      >();

      for (const c of conditions) {
        let entry = byTooth.get(c.tooth);
        if (!entry) {
          entry = {
            tooth: c.tooth,
            conditions: [],
            activeConditions: [],
            surfaces: {},
            isAbsent: false,
          };
          byTooth.set(c.tooth, entry);
        }
        entry.conditions.push(c);
        if (c.status !== 'active') continue;
        entry.activeConditions.push(c.condition);
        if (isAbsent(c.condition)) entry.isAbsent = true;
        if (c.surface) {
          (entry.surfaces[c.surface] ??= []).push(c.condition);
        }
      }

      return {
        patientId,
        conditions,
        teeth: [...byTooth.values()].sort((a, b) => a.tooth - b.tooth),
        summary: {
          total: conditions.length,
          active: conditions.filter((c) => c.status === 'active').length,
          activeCaries: conditions.filter(
            (c) => c.status === 'active' && c.condition === 'caries',
          ).length,
          teethCharted: byTooth.size,
        },
      };
    });
  }

  async addCondition(patientId: string, dto: CreateToothConditionDto, userId: string) {
    // Anatomy is enforced in the database too; checking here produces a message
    // that names the tooth rather than a constraint.
    if (dto.surface && !isValidSurface(dto.tooth, dto.surface)) {
      throw new BadRequestException(
        `Tooth ${dto.tooth} has no ${dto.surface} surface. Valid surfaces: ${surfacesFor(dto.tooth).join(', ')}.`,
      );
    }
    if (dto.surface && isWholeToothCondition(dto.condition)) {
      throw new BadRequestException(
        `"${dto.condition}" describes the whole tooth, so it cannot be recorded on one surface.`,
      );
    }

    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      await this.assertPatient(client, patientId);

      // A tooth recorded as extracted or missing cannot acquire new findings.
      // The schema cannot see this; it is a fact about other rows.
      if (!isAbsent(dto.condition)) {
        const { rows: absent } = await client.query<{ condition: string }>(
          `SELECT condition FROM tooth_conditions
            WHERE patient_id = $1 AND tooth = $2
              AND status = 'active' AND condition IN ('extracted','missing')
            LIMIT 1`,
          [patientId, dto.tooth],
        );
        if (absent[0]) {
          throw new ConflictException(
            `${toothLabel(dto.tooth)} is recorded as ${absent[0].condition}. ` +
              'Resolve that finding first if the tooth is present.',
          );
        }
      }

      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO tooth_conditions
             (tenant_id, patient_id, tooth, surface, condition, status, note,
              dentist_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            tenantId,
            patientId,
            dto.tooth,
            dto.surface ?? null,
            dto.condition,
            dto.status ?? 'active',
            dto.note ?? null,
            dto.dentistId ?? null,
            userId,
          ],
        );
        const { rows: full } = await client.query<ConditionRow>(
          `${COND_SELECT} WHERE c.id = $1`,
          [rows[0].id],
        );
        return mapCondition(full[0]);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === UNIQUE_VIOLATION) {
          throw new ConflictException(
            'That finding is already recorded on this tooth and surface.',
          );
        }
        if (code === CHECK_VIOLATION) {
          throw new BadRequestException(
            'That finding is not anatomically possible on this tooth.',
          );
        }
        throw err;
      }
    });
  }

  async updateCondition(id: string, dto: UpdateToothConditionDto) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (dto.status !== undefined) push('status', dto.status);
    if (dto.note !== undefined) push('note', dto.note || null);
    if (dto.dentistId !== undefined) push('dentist_id', dto.dentistId || null);
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      try {
        const { rows } = await client.query<{ id: string }>(
          `UPDATE tooth_conditions SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1 RETURNING id`,
          params,
        );
        if (!rows[0]) throw new NotFoundException('Finding not found');
        const { rows: full } = await client.query<ConditionRow>(
          `${COND_SELECT} WHERE c.id = $1`,
          [id],
        );
        return mapCondition(full[0]);
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictException(
            'Reactivating this would duplicate a finding already active on that surface.',
          );
        }
        throw err;
      }
    });
  }

  async deleteCondition(id: string) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM tooth_conditions WHERE id = $1',
        [id],
      );
      if (!rowCount) throw new NotFoundException('Finding not found');
      return { deleted: true as const };
    });
  }

  /* ── procedure code catalogue ── */

  async listCodes(opts: { system?: string; q?: string; includeInactive?: boolean }) {
    return this.tx(async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (!opts.includeInactive) where.push('p.is_active');
      if (opts.system) {
        params.push(opts.system);
        where.push(`p.system = $${params.length}`);
      }
      if (opts.q?.trim()) {
        // One parameter, referenced twice — simpler than rewriting placeholders.
        params.push(`%${opts.q.trim()}%`);
        const i = params.length;
        where.push(`(p.code ILIKE $${i} OR p.description ILIKE $${i})`);
      }
      const { rows } = await client.query<{
        id: string;
        system: string;
        code: string;
        description: string;
        default_fee: number;
        treatment_id: string | null;
        is_active: boolean;
      }>(
        `SELECT p.id, p.system, p.code, p.description, p.default_fee,
                p.treatment_id, p.is_active
           FROM procedure_codes p
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY p.system, p.code
          LIMIT 500`,
        params,
      );
      return rows.map((r) => ({
        id: r.id,
        system: r.system,
        code: r.code,
        description: r.description,
        defaultFee: r.default_fee,
        treatmentId: r.treatment_id,
        isActive: r.is_active,
      }));
    });
  }

  async createCode(dto: CreateProcedureCodeDto) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      try {
        const { rows } = await client.query<{
          id: string;
          system: string;
          code: string;
          description: string;
          default_fee: number;
          treatment_id: string | null;
          is_active: boolean;
        }>(
          `INSERT INTO procedure_codes
             (tenant_id, system, code, description, default_fee, treatment_id)
           VALUES ($1,$2,btrim($3),btrim($4),$5,$6)
           RETURNING id, system, code, description, default_fee, treatment_id, is_active`,
          [
            tenantId,
            dto.system,
            dto.code,
            dto.description,
            dto.defaultFee ?? 0,
            dto.treatmentId ?? null,
          ],
        );
        const r = rows[0];
        return {
          id: r.id,
          system: r.system,
          code: r.code,
          description: r.description,
          defaultFee: r.default_fee,
          treatmentId: r.treatment_id,
          isActive: r.is_active,
        };
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictException(
            `${dto.system} code "${dto.code.trim()}" already exists in your catalogue.`,
          );
        }
        throw err;
      }
    });
  }

  async updateCode(id: string, dto: UpdateProcedureCodeDto) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (frag: string, v: unknown) => {
      params.push(v);
      sets.push(frag.replace('$$', `$${params.length}`));
    };
    if (dto.code !== undefined) push('code = btrim($$)', dto.code);
    if (dto.description !== undefined) push('description = btrim($$)', dto.description);
    if (dto.defaultFee !== undefined) push('default_fee = $$', dto.defaultFee);
    if (dto.treatmentId !== undefined) push('treatment_id = $$', dto.treatmentId ?? null);
    if (dto.isActive !== undefined) push('is_active = $$', dto.isActive);
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      try {
        const { rows } = await client.query<{
          id: string;
          system: string;
          code: string;
          description: string;
          default_fee: number;
          treatment_id: string | null;
          is_active: boolean;
        }>(
          `UPDATE procedure_codes SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1
            RETURNING id, system, code, description, default_fee, treatment_id, is_active`,
          params,
        );
        if (!rows[0]) throw new NotFoundException('Code not found');
        const r = rows[0];
        return {
          id: r.id,
          system: r.system,
          code: r.code,
          description: r.description,
          defaultFee: r.default_fee,
          treatmentId: r.treatment_id,
          isActive: r.is_active,
        };
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictException(
            'Another code in that system already uses this value.',
          );
        }
        throw err;
      }
    });
  }

  async deleteCode(id: string) {
    return this.tx(async (client) => {
      const { rows: used } = await client.query<{ count: string }>(
        `SELECT (
           (SELECT count(*) FROM treatment_plan_items WHERE procedure_code_id = $1) +
           (SELECT count(*) FROM clinical_procedures
             WHERE procedure_code_id = $1 OR diagnosis_code_id = $1)
         )::text AS count`,
        [id],
      );
      if (Number(used[0]?.count ?? 0) > 0) {
        const { rowCount } = await client.query(
          'UPDATE procedure_codes SET is_active = false, updated_at = now() WHERE id = $1',
          [id],
        );
        if (!rowCount) throw new NotFoundException('Code not found');
        return {
          deleted: false as const,
          deactivated: true as const,
          usedBy: Number(used[0].count),
        };
      }
      const { rowCount } = await client.query(
        'DELETE FROM procedure_codes WHERE id = $1',
        [id],
      );
      if (!rowCount) throw new NotFoundException('Code not found');
      return { deleted: true as const, deactivated: false as const };
    });
  }

  /* ── procedure log ── */

  async listProcedures(patientId: string) {
    return this.tx(async (client) => {
      await this.assertPatient(client, patientId);
      const { rows } = await client.query<{
        id: string;
        tooth: number | null;
        surfaces: string[];
        description: string;
        status: string;
        fee: number;
        performed_on: string;
        note: string | null;
        clinician_id: string | null;
        clinician_name: string | null;
        code: string | null;
        code_system: string | null;
        diagnosis_code: string | null;
        diagnosis_system: string | null;
        plan_item_id: string | null;
        appointment_id: string | null;
      }>(
        `SELECT cp.id, cp.tooth, cp.surfaces, cp.description, cp.status, cp.fee,
                cp.performed_on::text AS performed_on, cp.note,
                cp.clinician_id, u.full_name AS clinician_name,
                pc.code, pc.system AS code_system,
                dc.code AS diagnosis_code, dc.system AS diagnosis_system,
                cp.plan_item_id, cp.appointment_id
           FROM clinical_procedures cp
           LEFT JOIN users u ON u.id = cp.clinician_id
           LEFT JOIN procedure_codes pc ON pc.id = cp.procedure_code_id
           LEFT JOIN procedure_codes dc ON dc.id = cp.diagnosis_code_id
          WHERE cp.patient_id = $1
          ORDER BY cp.performed_on DESC, cp.created_at DESC`,
        [patientId],
      );
      return rows.map((r) => ({
        id: r.id,
        tooth: r.tooth,
        surfaces: r.surfaces ?? [],
        description: r.description,
        status: r.status,
        fee: r.fee,
        performedOn: r.performed_on,
        note: r.note,
        clinicianId: r.clinician_id,
        clinicianName: r.clinician_name,
        code: r.code,
        codeSystem: r.code_system,
        diagnosisCode: r.diagnosis_code,
        diagnosisSystem: r.diagnosis_system,
        planItemId: r.plan_item_id,
        appointmentId: r.appointment_id,
      }));
    });
  }

  async logProcedure(patientId: string, dto: CreateProcedureDto, userId: string) {
    if (dto.tooth !== undefined && !isValidTooth(dto.tooth)) {
      throw new BadRequestException('Not a valid FDI tooth number');
    }
    for (const s of dto.surfaces ?? []) {
      if (dto.tooth === undefined) {
        throw new BadRequestException('Surfaces require a tooth');
      }
      if (!isValidSurface(dto.tooth, s)) {
        throw new BadRequestException(
          `Tooth ${dto.tooth} has no ${s} surface. Valid surfaces: ${surfacesFor(dto.tooth).join(', ')}.`,
        );
      }
    }

    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      await this.assertPatient(client, patientId);

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO clinical_procedures
           (tenant_id, patient_id, tooth, surfaces, procedure_code_id, diagnosis_code_id,
            treatment_id, plan_item_id, appointment_id, description, clinician_id,
            status, fee, performed_on, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 coalesce($14::date, CURRENT_DATE),$15,$16)
         RETURNING id`,
        [
          tenantId,
          patientId,
          dto.tooth ?? null,
          dto.surfaces ?? [],
          dto.procedureCodeId ?? null,
          dto.diagnosisCodeId ?? null,
          dto.treatmentId ?? null,
          dto.planItemId ?? null,
          dto.appointmentId ?? null,
          dto.description,
          dto.clinicianId ?? userId,
          dto.status ?? 'completed',
          dto.fee ?? 0,
          dto.performedOn ?? null,
          dto.note ?? null,
          userId,
        ],
      );
      const procedureId = rows[0].id;

      // Close out the findings this procedure treated, in the same transaction
      // so the chart can never show a completed filling beside live caries.
      if (dto.resolvesConditionIds?.length) {
        await client.query(
          `UPDATE tooth_conditions
              SET status = 'treated', resolved_by_procedure_id = $2, updated_at = now()
            WHERE id = ANY($1::uuid[]) AND patient_id = $3`,
          [dto.resolvesConditionIds, procedureId, patientId],
        );
      }

      // Keep the plan line in step when the work came from a treatment plan.
      if (dto.planItemId && (dto.status ?? 'completed') === 'completed') {
        await client.query(
          `UPDATE treatment_plan_items SET status = 'completed', updated_at = now()
            WHERE id = $1`,
          [dto.planItemId],
        );
      }

      const list = await this.listProceduresIn(client, patientId, procedureId);
      return list;
    });
  }

  private async listProceduresIn(client: PoolClient, patientId: string, id: string) {
    const { rows } = await client.query<{
      id: string;
      tooth: number | null;
      surfaces: string[];
      description: string;
      status: string;
      fee: number;
      performed_on: string;
      note: string | null;
      clinician_name: string | null;
      code: string | null;
      code_system: string | null;
    }>(
      `SELECT cp.id, cp.tooth, cp.surfaces, cp.description, cp.status, cp.fee,
              cp.performed_on::text AS performed_on, cp.note,
              u.full_name AS clinician_name, pc.code, pc.system AS code_system
         FROM clinical_procedures cp
         LEFT JOIN users u ON u.id = cp.clinician_id
         LEFT JOIN procedure_codes pc ON pc.id = cp.procedure_code_id
        WHERE cp.id = $1 AND cp.patient_id = $2`,
      [id, patientId],
    );
    const r = rows[0];
    return {
      id: r.id,
      tooth: r.tooth,
      surfaces: r.surfaces ?? [],
      description: r.description,
      status: r.status,
      fee: r.fee,
      performedOn: r.performed_on,
      note: r.note,
      clinicianName: r.clinician_name,
      code: r.code,
      codeSystem: r.code_system,
    };
  }

  async updateProcedure(id: string, dto: UpdateProcedureDto) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (frag: string, v: unknown) => {
      params.push(v);
      sets.push(frag.replace('$$', `$${params.length}`));
    };
    if (dto.description !== undefined) push('description = $$', dto.description);
    if (dto.status !== undefined) push('status = $$', dto.status);
    if (dto.fee !== undefined) push('fee = $$', dto.fee);
    if (dto.performedOn !== undefined) push('performed_on = $$::date', dto.performedOn);
    if (dto.clinicianId !== undefined) push('clinician_id = $$', dto.clinicianId ?? null);
    if (dto.note !== undefined) push('note = $$', dto.note || null);
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      const { rows } = await client.query<{ patient_id: string }>(
        `UPDATE clinical_procedures SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $1 RETURNING patient_id`,
        params,
      );
      if (!rows[0]) throw new NotFoundException('Procedure not found');
      return this.listProceduresIn(client, rows[0].patient_id, id);
    });
  }

  async deleteProcedure(id: string) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM clinical_procedures WHERE id = $1',
        [id],
      );
      if (!rowCount) throw new NotFoundException('Procedure not found');
      return { deleted: true as const };
    });
  }
}
