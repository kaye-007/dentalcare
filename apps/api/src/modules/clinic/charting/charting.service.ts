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
import {
  rethrowRecordLocked,
  signEntry,
  withdrawEntry,
} from '@/core/audit/clinical-record';
import {
  type Surface,
  type ToothCondition,
  isAbsent,
  isValidSurface,
  isValidTooth,
  isWholeToothCondition,
  surfacesFor,
  toothLabel,
  vatCategoryOf,
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
 * The database enforces anatomy (a molar has no incisal edge), uniqueness of
 * active findings, and — since 0004 — the integrity of the record: nothing
 * here is ever deleted, a wrong entry is withdrawn as entered in error, and a
 * signed procedure cannot be edited at all. This layer enforces the rules
 * that need context the schema cannot see — chiefly that you cannot chart a
 * new finding on a tooth already recorded as extracted — and writes every
 * change to the activity trail in the same transaction as the change.
 *
 * Every read excludes withdrawn rows. They remain in the database with who
 * withdrew them and why; they are not part of the chart.
 */

const UNIQUE_VIOLATION = '23505';

const CHECK_VIOLATION = '23514';

/** "root_canal" -> "root canal", for sentences in the activity trail. */
const words = (s: string) => s.replace(/_/g, ' ');

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
  source: string;
  recorded_at: string;
  updated_at: string;
}

const COND_SELECT = `
  SELECT c.id, c.tooth, c.surface, c.condition, c.status, c.note,
         c.dentist_id, u.full_name AS dentist_name,
         c.resolved_by_procedure_id, c.source, c.recorded_at, c.updated_at
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
  source: r.source,
  recordedAt: r.recorded_at,
  updatedAt: r.updated_at,
});

/** A procedure row as `SELECT *` returns it — what withdraw and sign lock. */
interface ProcedureLockRow {
  id: string;
  patient_id: string;
  tooth: number | null;
  description: string;
  status: string;
  plan_item_id: string | null;
  signed_at: string | null;
  entered_in_error_at: string | null;
}

const describeProcedure = (r: { description: string; tooth: number | null }) =>
  `"${r.description}"${r.tooth ? ` on ${toothLabel(r.tooth)}` : ''}`;

const PROC_SELECT = `
  SELECT cp.id, cp.tooth, cp.surfaces, cp.description, cp.status, cp.fee,
         cp.performed_on::text AS performed_on, cp.note,
         cp.clinician_id, u.full_name AS clinician_name,
         pc.code, pc.system AS code_system,
         dc.code AS diagnosis_code, dc.system AS diagnosis_system,
         cp.plan_item_id, cp.appointment_id, cp.source,
         cp.signed_at, su.full_name AS signed_by_name
    FROM clinical_procedures cp
    LEFT JOIN users u ON u.id = cp.clinician_id
    LEFT JOIN users su ON su.id = cp.signed_by
    LEFT JOIN procedure_codes pc ON pc.id = cp.procedure_code_id
    LEFT JOIN procedure_codes dc ON dc.id = cp.diagnosis_code_id`;

interface ProcedureRow {
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
  source: string;
  signed_at: string | null;
  signed_by_name: string | null;
}

const mapProcedure = (r: ProcedureRow) => ({
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
  source: r.source,
  signedAt: r.signed_at,
  signedByName: r.signed_by_name,
});

@Injectable()
export class ChartingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  private async assertPatient(client: PoolClient, patientId: string) {
    const r = await client.query('SELECT 1 FROM patients WHERE id = $1', [patientId]);
    if (!r.rowCount) throw new NotFoundException('Patient not found');
  }

  /** The patient's name for an activity line; 404 if they do not exist. */
  private async patientName(client: PoolClient, patientId: string): Promise<string> {
    const { rows } = await client.query<{ name: string }>(
      `SELECT first_name || ' ' || last_name AS name FROM patients WHERE id = $1`,
      [patientId],
    );
    if (!rows[0]) throw new NotFoundException('Patient not found');
    return rows[0].name;
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
        `${COND_SELECT}
          WHERE c.patient_id = $1 AND c.entered_in_error_at IS NULL
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

  async addCondition(
    patientId: string,
    dto: CreateToothConditionDto,
    actor: ClinicAuditActor,
  ) {
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
      const patient = await this.patientName(client, patientId);

      // A tooth recorded as extracted or missing cannot acquire new findings.
      // The schema cannot see this; it is a fact about other rows.
      if (!isAbsent(dto.condition)) {
        const { rows: absent } = await client.query<{ condition: string }>(
          `SELECT condition FROM tooth_conditions
            WHERE patient_id = $1 AND tooth = $2
              AND status = 'active' AND condition IN ('extracted','missing')
              AND entered_in_error_at IS NULL
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

      let id: string;
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
            actor.userId,
          ],
        );
        id = rows[0]!.id;
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

      await this.audit.record(client, actor, {
        action: 'clinical.finding_recorded',
        entityType: 'tooth_condition',
        entityId: id,
        summary: `Recorded ${words(dto.condition)} on ${toothLabel(dto.tooth)}${
          dto.surface ? ` (${dto.surface})` : ''
        } for ${patient}`,
        metadata: {
          patientId,
          tooth: dto.tooth,
          surface: dto.surface ?? null,
          condition: dto.condition,
        },
      });

      const { rows: full } = await client.query<ConditionRow>(
        `${COND_SELECT} WHERE c.id = $1`,
        [id],
      );
      return mapCondition(full[0]!);
    });
  }

  async updateCondition(id: string, dto: UpdateToothConditionDto, actor: ClinicAuditActor) {
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
      const { rows: before } = await client.query<{
        patient_id: string;
        tooth: number;
        condition: string;
        status: string;
      }>(
        `SELECT patient_id, tooth, condition, status FROM tooth_conditions
          WHERE id = $1 AND entered_in_error_at IS NULL
          FOR UPDATE`,
        [id],
      );
      const prev = before[0];
      if (!prev) throw new NotFoundException('Finding not found');

      try {
        await client.query(
          `UPDATE tooth_conditions SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1`,
          params,
        );
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictException(
            'Reactivating this would duplicate a finding already active on that surface.',
          );
        }
        rethrowRecordLocked(err);
      }

      const statusMoved = dto.status !== undefined && dto.status !== prev.status;
      await this.audit.record(client, actor, {
        action: 'clinical.finding_updated',
        entityType: 'tooth_condition',
        entityId: id,
        summary: statusMoved
          ? `Marked ${words(prev.condition)} on ${toothLabel(prev.tooth)} as ${dto.status}`
          : `Updated ${words(prev.condition)} on ${toothLabel(prev.tooth)}`,
        metadata: {
          patientId: prev.patient_id,
          fields: Object.keys(dto).filter(
            (k) => (dto as Record<string, unknown>)[k] !== undefined,
          ),
          ...(statusMoved ? { statusFrom: prev.status, statusTo: dto.status } : {}),
        },
      });

      const { rows: full } = await client.query<ConditionRow>(
        `${COND_SELECT} WHERE c.id = $1`,
        [id],
      );
      return mapCondition(full[0]!);
    });
  }

  /** Withdraw a finding as entered in error. It stays in the database. */
  async withdrawCondition(id: string, reason: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      await withdrawEntry<{
        patient_id: string;
        entered_in_error_at: unknown;
        tooth: number;
        condition: string;
      }>(client, this.audit, actor, {
        table: 'tooth_conditions',
        id,
        reason,
        action: 'clinical.finding_withdrawn',
        describe: (r) => `${words(r.condition)} on ${toothLabel(r.tooth)}`,
      });
      return { withdrawn: true as const };
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
        is_taxable: boolean;
      }>(
        `SELECT p.id, p.system, p.code, p.description, p.default_fee,
                p.treatment_id, p.is_active, p.is_taxable
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
        vatCategory: vatCategoryOf(r.is_taxable),
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
          is_taxable: boolean;
        }>(
          `INSERT INTO procedure_codes
             (tenant_id, system, code, description, default_fee, treatment_id, is_taxable)
           VALUES ($1,$2,btrim($3),btrim($4),$5,$6,$7)
           RETURNING id, system, code, description, default_fee, treatment_id, is_active, is_taxable`,
          [
            tenantId,
            dto.system,
            dto.code,
            dto.description,
            dto.defaultFee ?? 0,
            dto.treatmentId ?? null,
            dto.vatCategory === 'cosmetic',
          ],
        );
        const r = rows[0]!;
        return {
          id: r.id,
          system: r.system,
          code: r.code,
          description: r.description,
          defaultFee: r.default_fee,
          treatmentId: r.treatment_id,
          isActive: r.is_active,
          vatCategory: vatCategoryOf(r.is_taxable),
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
    if (dto.vatCategory !== undefined) push('is_taxable = $$', dto.vatCategory === 'cosmetic');
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
          is_taxable: boolean;
        }>(
          `UPDATE procedure_codes SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1
            RETURNING id, system, code, description, default_fee, treatment_id, is_active, is_taxable`,
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
          vatCategory: vatCategoryOf(r.is_taxable),
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
      // Withdrawn procedures still reference their code, so they count as use:
      // deleting the code would orphan the record of what was withdrawn.
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
          usedBy: Number(used[0]!.count),
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
      const { rows } = await client.query<ProcedureRow>(
        `${PROC_SELECT}
          WHERE cp.patient_id = $1 AND cp.entered_in_error_at IS NULL
          ORDER BY cp.performed_on DESC, cp.created_at DESC`,
        [patientId],
      );
      return rows.map(mapProcedure);
    });
  }

  async logProcedure(patientId: string, dto: CreateProcedureDto, actor: ClinicAuditActor) {
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
      const patient = await this.patientName(client, patientId);
      const status = dto.status ?? 'completed';

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
          dto.clinicianId ?? actor.userId,
          status,
          dto.fee ?? 0,
          dto.performedOn ?? null,
          dto.note ?? null,
          actor.userId,
        ],
      );
      const procedureId = rows[0]!.id;

      // Close out the findings this procedure treated, in the same transaction
      // so the chart can never show a completed filling beside live caries.
      if (dto.resolvesConditionIds?.length) {
        await client.query(
          `UPDATE tooth_conditions
              SET status = 'treated', resolved_by_procedure_id = $2, updated_at = now()
            WHERE id = ANY($1::uuid[]) AND patient_id = $3
              AND entered_in_error_at IS NULL`,
          [dto.resolvesConditionIds, procedureId, patientId],
        );
      }

      // Keep the plan line in step when the work came from a treatment plan.
      if (dto.planItemId && status === 'completed') {
        await client.query(
          `UPDATE treatment_plan_items SET status = 'completed', updated_at = now()
            WHERE id = $1`,
          [dto.planItemId],
        );
      }

      await this.audit.record(client, actor, {
        action: 'clinical.procedure_logged',
        entityType: 'clinical_procedure',
        entityId: procedureId,
        summary: `Logged ${describeProcedure({
          description: dto.description,
          tooth: dto.tooth ?? null,
        })} (${words(status)}) for ${patient}`,
        metadata: { patientId, status, fee: dto.fee ?? 0, tooth: dto.tooth ?? null },
      });

      return this.procedureIn(client, patientId, procedureId);
    });
  }

  private async procedureIn(client: PoolClient, patientId: string, id: string) {
    const { rows } = await client.query<ProcedureRow>(
      `${PROC_SELECT} WHERE cp.id = $1 AND cp.patient_id = $2`,
      [id, patientId],
    );
    return mapProcedure(rows[0]!);
  }

  async updateProcedure(id: string, dto: UpdateProcedureDto, actor: ClinicAuditActor) {
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
      const { rows: before } = await client.query<{
        patient_id: string;
        description: string;
        tooth: number | null;
        status: string;
        fee: number;
      }>(
        `SELECT patient_id, description, tooth, status, fee FROM clinical_procedures
          WHERE id = $1 AND entered_in_error_at IS NULL
          FOR UPDATE`,
        [id],
      );
      const prev = before[0];
      if (!prev) throw new NotFoundException('Procedure not found');

      try {
        await client.query(
          `UPDATE clinical_procedures SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1`,
          params,
        );
      } catch (err) {
        rethrowRecordLocked(err);
      }

      const feeMoved = dto.fee !== undefined && dto.fee !== prev.fee;
      const statusMoved = dto.status !== undefined && dto.status !== prev.status;
      await this.audit.record(client, actor, {
        action: 'clinical.procedure_updated',
        entityType: 'clinical_procedure',
        entityId: id,
        summary: `Updated ${describeProcedure(prev)}`,
        metadata: {
          patientId: prev.patient_id,
          fields: Object.keys(dto).filter(
            (k) => (dto as Record<string, unknown>)[k] !== undefined,
          ),
          ...(feeMoved ? { feeFrom: prev.fee, feeTo: dto.fee } : {}),
          ...(statusMoved ? { statusFrom: prev.status, statusTo: dto.status } : {}),
        },
      });

      return this.procedureIn(client, prev.patient_id, id);
    });
  }

  /**
   * Sign a completed or cancelled procedure. From here on the database refuses
   * every edit; the only correction is to withdraw it and log it again.
   */
  async signProcedure(id: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const row = await signEntry<ProcedureLockRow>(client, this.audit, actor, {
        table: 'clinical_procedures',
        id,
        action: 'clinical.procedure_signed',
        describe: describeProcedure,
        assert: (r) => {
          if (r.status !== 'completed' && r.status !== 'cancelled') {
            throw new ConflictException(
              'Only a completed or cancelled procedure can be signed. Finish it first.',
            );
          }
        },
      });
      return this.procedureIn(client, row.patient_id, id);
    });
  }

  /**
   * Withdraw a procedure as entered in error.
   *
   * If it never happened, neither did its consequences: findings it marked as
   * treated are open again, and a plan line it completed goes back to planned.
   * A finding is only reopened when that would not duplicate one charted
   * since. A procedure already on a live invoice is refused by the database —
   * the invoice has to be dealt with first.
   */
  async withdrawProcedure(id: string, reason: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const row = await withdrawEntry<ProcedureLockRow>(client, this.audit, actor, {
        table: 'clinical_procedures',
        id,
        reason,
        action: 'clinical.procedure_withdrawn',
        describe: describeProcedure,
      });

      await client.query(
        `UPDATE tooth_conditions c
            SET status = 'active', resolved_by_procedure_id = NULL, updated_at = now()
          WHERE c.resolved_by_procedure_id = $1
            AND c.status = 'treated'
            AND c.entered_in_error_at IS NULL
            AND NOT EXISTS (
                  SELECT 1 FROM tooth_conditions d
                   WHERE d.patient_id = c.patient_id
                     AND d.tooth = c.tooth
                     AND COALESCE(d.surface, '*') = COALESCE(c.surface, '*')
                     AND d.condition = c.condition
                     AND d.status = 'active'
                     AND d.entered_in_error_at IS NULL)`,
        [id],
      );

      if (row.plan_item_id) {
        await client.query(
          `UPDATE treatment_plan_items SET status = 'planned', updated_at = now()
            WHERE id = $1 AND status = 'completed'`,
          [row.plan_item_id],
        );
      }

      return { withdrawn: true as const };
    });
  }
}
