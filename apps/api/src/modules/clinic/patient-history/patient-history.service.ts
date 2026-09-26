import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { rethrowRecordLocked, withdrawEntry } from '@/core/audit/clinical-record';
import { CreateAllergyDto, CreateConditionDto, CreateMedicationDto, UpdateAllergyDto, UpdateConditionDto, UpdateMedicationDto } from './dto/patient-history.dto';

/* ═════════════════════════ service ═════════════════════════ */

/**
 * Allergies, medical conditions and medications.
 *
 * Nothing here is deleted. An allergy recorded against the wrong patient, or
 * a medication that was never prescribed, is withdrawn as entered in error:
 * it leaves every list and summary and stays in the database with who
 * withdrew it and why. A condition that has simply got better is RESOLVED,
 * and a medication that has stopped is ENDED — those are facts about the
 * patient, not corrections of the record, and they are different verbs on
 * purpose.
 */

interface AllergyRow {
  id: string; substance: string; reaction: string | null;
  severity: 'mild' | 'moderate' | 'severe'; notes: string | null;
  recorded_by_name: string | null; created_at: string; updated_at: string;
  patient_id?: string;
}

interface ConditionRow {
  id: string; name: string; status: 'active' | 'resolved';
  diagnosed_on: string | null; notes: string | null;
  recorded_by_name: string | null; created_at: string; updated_at: string;
  patient_id?: string;
}

interface MedicationRow {
  id: string; name: string; dosage: string | null; frequency: string | null;
  started_on: string | null; ended_on: string | null; notes: string | null;
  recorded_by_name: string | null; created_at: string; updated_at: string;
  patient_id?: string;
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

const changedFields = (dto: object) =>
  Object.entries(dto)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);

@Injectable()
export class PatientHistoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /**
   * RLS already confines us to this clinic; this additionally proves the
   * patient exists, so a bad id is a clean 404 instead of a foreign-key error.
   */
  private async assertPatient(client: PoolClient, patientId: string) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM patients WHERE id = $1',
      [patientId],
    );
    if (!rowCount) throw new NotFoundException('Patient not found');
  }

  private async patientName(client: PoolClient, patientId: string): Promise<string> {
    const { rows } = await client.query<{ name: string }>(
      `SELECT first_name || ' ' || last_name AS name FROM patients WHERE id = $1`,
      [patientId],
    );
    if (!rows[0]) throw new NotFoundException('Patient not found');
    return rows[0].name;
  }

  /* ── allergies ── */

  async listAllergies(patientId: string) {
    return this.tx(async (client) => {
      await this.assertPatient(client, patientId);
      const { rows } = await client.query<AllergyRow>(
        `SELECT a.id, a.substance, a.reaction, a.severity, a.notes,
                u.full_name AS recorded_by_name, a.created_at, a.updated_at
           FROM patient_allergies a
           LEFT JOIN users u ON u.id = a.recorded_by
          WHERE a.patient_id = $1 AND a.entered_in_error_at IS NULL
          ORDER BY CASE a.severity
                     WHEN 'severe' THEN 0 WHEN 'moderate' THEN 1 ELSE 2
                   END,
                   lower(a.substance)`,
        [patientId],
      );
      return rows.map(mapAllergy);
    });
  }

  async createAllergy(patientId: string, dto: CreateAllergyDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const patient = await this.patientName(client, patientId);
      let row: AllergyRow;
      try {
        const { rows } = await client.query<AllergyRow>(
          `INSERT INTO patient_allergies
             (tenant_id, patient_id, substance, reaction, severity, notes, recorded_by)
           VALUES ($1,$2,btrim($3),$4,$5,$6,$7)
           RETURNING id, substance, reaction, severity, notes,
                     NULL::text AS recorded_by_name, created_at, updated_at`,
          [tenantId, patientId, dto.substance, dto.reaction ?? null,
           dto.severity, dto.notes ?? null, actor.userId],
        );
        row = rows[0]!;
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new BadRequestException(
            `An allergy to "${dto.substance.trim()}" is already recorded for this patient`,
          );
        }
        throw err;
      }
      await this.audit.record(client, actor, {
        action: 'clinical.history_recorded',
        entityType: 'patient_allergy',
        entityId: row.id,
        summary: `Recorded a ${row.severity} allergy to ${row.substance} for ${patient}`,
        metadata: { patientId, severity: row.severity },
      });
      return mapAllergy(row);
    });
  }

  async updateAllergy(id: string, dto: UpdateAllergyDto, actor: ClinicAuditActor) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (dto.substance !== undefined) push('substance', dto.substance.trim());
    if (dto.reaction !== undefined) push('reaction', dto.reaction || null);
    if (dto.severity !== undefined) push('severity', dto.severity);
    if (dto.notes !== undefined) push('notes', dto.notes || null);
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      let row: AllergyRow | undefined;
      try {
        const { rows } = await client.query<AllergyRow>(
          `UPDATE patient_allergies SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1 AND entered_in_error_at IS NULL
            RETURNING id, substance, reaction, severity, notes, patient_id,
                      NULL::text AS recorded_by_name, created_at, updated_at`,
          params,
        );
        row = rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new BadRequestException(
            'That substance is already recorded for this patient',
          );
        }
        rethrowRecordLocked(err);
      }
      if (!row) throw new NotFoundException('Allergy not found');
      await this.audit.record(client, actor, {
        action: 'clinical.history_updated',
        entityType: 'patient_allergy',
        entityId: id,
        summary: `Updated the allergy to ${row.substance}`,
        metadata: { patientId: row.patient_id, fields: changedFields(dto) },
      });
      return mapAllergy(row);
    });
  }

  async withdrawAllergy(id: string, reason: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      await withdrawEntry<{ patient_id: string; entered_in_error_at: unknown; substance: string }>(
        client, this.audit, actor, {
          table: 'patient_allergies',
          id,
          reason,
          action: 'clinical.history_withdrawn',
          describe: (r) => `the allergy to ${r.substance}`,
        },
      );
      return { withdrawn: true as const };
    });
  }

  /* ── conditions ── */

  async listConditions(patientId: string) {
    return this.tx(async (client) => {
      await this.assertPatient(client, patientId);
      const { rows } = await client.query<ConditionRow>(
        `SELECT c.id, c.name, c.status, c.diagnosed_on, c.notes,
                u.full_name AS recorded_by_name, c.created_at, c.updated_at
           FROM patient_conditions c
           LEFT JOIN users u ON u.id = c.recorded_by
          WHERE c.patient_id = $1 AND c.entered_in_error_at IS NULL
          ORDER BY (c.status = 'resolved'), c.diagnosed_on DESC NULLS LAST, lower(c.name)`,
        [patientId],
      );
      return rows.map(mapCondition);
    });
  }

  async createCondition(patientId: string, dto: CreateConditionDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const patient = await this.patientName(client, patientId);
      const { rows } = await client.query<ConditionRow>(
        `INSERT INTO patient_conditions
           (tenant_id, patient_id, name, status, diagnosed_on, notes, recorded_by)
         VALUES ($1,$2,btrim($3),$4,$5,$6,$7)
         RETURNING id, name, status, diagnosed_on, notes,
                   NULL::text AS recorded_by_name, created_at, updated_at`,
        [tenantId, patientId, dto.name, dto.status ?? 'active',
         dto.diagnosedOn || null, dto.notes ?? null, actor.userId],
      );
      const row = rows[0]!;
      await this.audit.record(client, actor, {
        action: 'clinical.history_recorded',
        entityType: 'patient_condition',
        entityId: row.id,
        summary: `Recorded the condition "${row.name}" for ${patient}`,
        metadata: { patientId, status: row.status },
      });
      return mapCondition(row);
    });
  }

  async updateCondition(id: string, dto: UpdateConditionDto, actor: ClinicAuditActor) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (dto.name !== undefined) push('name', dto.name.trim());
    if (dto.status !== undefined) push('status', dto.status);
    if (dto.diagnosedOn !== undefined) push('diagnosed_on', dto.diagnosedOn || null);
    if (dto.notes !== undefined) push('notes', dto.notes || null);
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      let row: ConditionRow | undefined;
      try {
        const { rows } = await client.query<ConditionRow>(
          `UPDATE patient_conditions SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1 AND entered_in_error_at IS NULL
            RETURNING id, name, status, diagnosed_on, notes, patient_id,
                      NULL::text AS recorded_by_name, created_at, updated_at`,
          params,
        );
        row = rows[0];
      } catch (err) {
        rethrowRecordLocked(err);
      }
      if (!row) throw new NotFoundException('Condition not found');
      await this.audit.record(client, actor, {
        action: 'clinical.history_updated',
        entityType: 'patient_condition',
        entityId: id,
        summary:
          dto.status === 'resolved'
            ? `Marked the condition "${row.name}" as resolved`
            : `Updated the condition "${row.name}"`,
        metadata: { patientId: row.patient_id, fields: changedFields(dto) },
      });
      return mapCondition(row);
    });
  }

  async withdrawCondition(id: string, reason: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      await withdrawEntry<{ patient_id: string; entered_in_error_at: unknown; name: string }>(
        client, this.audit, actor, {
          table: 'patient_conditions',
          id,
          reason,
          action: 'clinical.history_withdrawn',
          describe: (r) => `the condition "${r.name}"`,
        },
      );
      return { withdrawn: true as const };
    });
  }

  /* ── medications ── */

  async listMedications(patientId: string) {
    return this.tx(async (client) => {
      await this.assertPatient(client, patientId);
      const { rows } = await client.query<MedicationRow>(
        `SELECT m.id, m.name, m.dosage, m.frequency, m.started_on, m.ended_on,
                m.notes, u.full_name AS recorded_by_name, m.created_at, m.updated_at
           FROM patient_medications m
           LEFT JOIN users u ON u.id = m.recorded_by
          WHERE m.patient_id = $1 AND m.entered_in_error_at IS NULL
          ORDER BY (m.ended_on IS NOT NULL), m.started_on DESC NULLS LAST, lower(m.name)`,
        [patientId],
      );
      return rows.map(mapMedication);
    });
  }

  async createMedication(patientId: string, dto: CreateMedicationDto, actor: ClinicAuditActor) {
    assertDateOrder(dto.startedOn, dto.endedOn);
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const patient = await this.patientName(client, patientId);
      const { rows } = await client.query<MedicationRow>(
        `INSERT INTO patient_medications
           (tenant_id, patient_id, name, dosage, frequency, started_on, ended_on, notes, recorded_by)
         VALUES ($1,$2,btrim($3),$4,$5,$6,$7,$8,$9)
         RETURNING id, name, dosage, frequency, started_on, ended_on, notes,
                   NULL::text AS recorded_by_name, created_at, updated_at`,
        [tenantId, patientId, dto.name, dto.dosage ?? null, dto.frequency ?? null,
         dto.startedOn || null, dto.endedOn || null, dto.notes ?? null, actor.userId],
      );
      const row = rows[0]!;
      await this.audit.record(client, actor, {
        action: 'clinical.history_recorded',
        entityType: 'patient_medication',
        entityId: row.id,
        summary: `Recorded the medication ${row.name} for ${patient}`,
        metadata: { patientId },
      });
      return mapMedication(row);
    });
  }

  async updateMedication(id: string, dto: UpdateMedicationDto, actor: ClinicAuditActor) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (dto.name !== undefined) push('name', dto.name.trim());
    if (dto.dosage !== undefined) push('dosage', dto.dosage || null);
    if (dto.frequency !== undefined) push('frequency', dto.frequency || null);
    if (dto.startedOn !== undefined) push('started_on', dto.startedOn || null);
    if (dto.endedOn !== undefined) push('ended_on', dto.endedOn || null);
    if (dto.notes !== undefined) push('notes', dto.notes || null);
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      // Validate the resulting row, not just the patch — a lone endedOn must
      // still be checked against the startedOn already stored.
      const { rows: existing } = await client.query<{
        started_on: string | null; ended_on: string | null;
      }>(
        `SELECT started_on, ended_on FROM patient_medications
          WHERE id = $1 AND entered_in_error_at IS NULL`,
        [id],
      );
      if (!existing[0]) throw new NotFoundException('Medication not found');
      assertDateOrder(
        dto.startedOn !== undefined ? dto.startedOn || null : existing[0].started_on,
        dto.endedOn !== undefined ? dto.endedOn || null : existing[0].ended_on,
      );

      let row: MedicationRow | undefined;
      try {
        const { rows } = await client.query<MedicationRow>(
          `UPDATE patient_medications SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1
            RETURNING id, name, dosage, frequency, started_on, ended_on, notes, patient_id,
                      NULL::text AS recorded_by_name, created_at, updated_at`,
          params,
        );
        row = rows[0];
      } catch (err) {
        rethrowRecordLocked(err);
      }
      if (!row) throw new NotFoundException('Medication not found');
      await this.audit.record(client, actor, {
        action: 'clinical.history_updated',
        entityType: 'patient_medication',
        entityId: id,
        summary:
          dto.endedOn && !existing[0].ended_on
            ? `Stopped the medication ${row.name}`
            : `Updated the medication ${row.name}`,
        metadata: { patientId: row.patient_id, fields: changedFields(dto) },
      });
      return mapMedication(row);
    });
  }

  async withdrawMedication(id: string, reason: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      await withdrawEntry<{ patient_id: string; entered_in_error_at: unknown; name: string }>(
        client, this.audit, actor, {
          table: 'patient_medications',
          id,
          reason,
          action: 'clinical.history_withdrawn',
          describe: (r) => `the medication ${r.name}`,
        },
      );
      return { withdrawn: true as const };
    });
  }

  /**
   * Everything a clinician needs before treating, in one round trip. Used by
   * the profile page and by the chart's allergy banner.
   */
  async summary(patientId: string) {
    const [allergies, conditions, medications] = await Promise.all([
      this.listAllergies(patientId),
      this.listConditions(patientId),
      this.listMedications(patientId),
    ]);
    return {
      allergies,
      conditions,
      medications,
      /** Drives the red banner on the chart. */
      hasSevereAllergy: allergies.some((a) => a.severity === 'severe'),
      activeConditionCount: conditions.filter((c) => c.status === 'active').length,
      currentMedicationCount: medications.filter((m) => !m.endedOn).length,
    };
  }
}

function assertDateOrder(started?: string | null, ended?: string | null) {
  if (started && ended && new Date(ended) < new Date(started)) {
    throw new BadRequestException('End date cannot be before the start date');
  }
}

const mapAllergy = (r: AllergyRow) => ({
  id: r.id,
  substance: r.substance,
  reaction: r.reaction,
  severity: r.severity,
  notes: r.notes,
  recordedByName: r.recorded_by_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapCondition = (r: ConditionRow) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  diagnosedOn: r.diagnosed_on,
  notes: r.notes,
  recordedByName: r.recorded_by_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapMedication = (r: MedicationRow) => ({
  id: r.id,
  name: r.name,
  dosage: r.dosage,
  frequency: r.frequency,
  startedOn: r.started_on,
  endedOn: r.ended_on,
  /** Derived rather than stored, so it can never disagree with endedOn. */
  isCurrent: r.ended_on === null,
  notes: r.notes,
  recordedByName: r.recorded_by_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
