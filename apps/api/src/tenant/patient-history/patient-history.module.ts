import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessTokenPayload } from '../auth/auth.service';
import { PermissionsGuard } from '../../core/authz/permissions.guard';
import { RequirePermissions } from '../../core/authz/permissions.decorator';
import { AuthModule } from '../auth/auth.module';

/**
 * Structured medical history: allergies, conditions and medications.
 *
 * Kept out of `medical-record/` on purpose — that module is the odontogram,
 * which is per-tooth and per-visit. This is patient-level background that a
 * clinician must see BEFORE touching a tooth, and that the front desk must be
 * able to read (to warn a dentist) without being able to edit.
 *
 * Reads need `clinical:read`, writes need `clinical:write`. Under the Phase 1
 * matrix that means every role can read an allergy, and only admin and
 * dentist can record or change one.
 */

/* ══════════════════════════ DTOs ══════════════════════════ */

export class CreateAllergyDto {
  @IsString() @MinLength(1, { message: 'Substance is required' }) @MaxLength(120)
  substance!: string;

  @IsOptional() @IsString() @MaxLength(300)
  reaction?: string;

  @IsIn(['mild', 'moderate', 'severe'], {
    message: 'Severity must be mild, moderate or severe',
  })
  severity!: 'mild' | 'moderate' | 'severe';

  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string;
}

export class UpdateAllergyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  substance?: string;

  @IsOptional() @IsString() @MaxLength(300)
  reaction?: string;

  @IsOptional() @IsIn(['mild', 'moderate', 'severe'])
  severity?: 'mild' | 'moderate' | 'severe';

  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string;
}

export class CreateConditionDto {
  @IsString() @MinLength(1, { message: 'Condition name is required' }) @MaxLength(160)
  name!: string;

  @IsOptional() @IsIn(['active', 'resolved'])
  status?: 'active' | 'resolved';

  @IsOptional() @IsISO8601({}, { message: 'Diagnosed date must be a valid date' })
  diagnosedOn?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string;
}

export class UpdateConditionDto extends CreateConditionDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160)
  declare name: string;
}

export class CreateMedicationDto {
  @IsString() @MinLength(1, { message: 'Medication name is required' }) @MaxLength(160)
  name!: string;

  @IsOptional() @IsString() @MaxLength(80)
  dosage?: string;

  @IsOptional() @IsString() @MaxLength(80)
  frequency?: string;

  @IsOptional() @IsISO8601({}, { message: 'Start date must be a valid date' })
  startedOn?: string;

  @IsOptional() @IsISO8601({}, { message: 'End date must be a valid date' })
  endedOn?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string;
}

export class UpdateMedicationDto extends CreateMedicationDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160)
  declare name: string;
}

/* ═════════════════════════ service ═════════════════════════ */

interface AllergyRow {
  id: string; substance: string; reaction: string | null;
  severity: 'mild' | 'moderate' | 'severe'; notes: string | null;
  recorded_by_name: string | null; created_at: string; updated_at: string;
}
interface ConditionRow {
  id: string; name: string; status: 'active' | 'resolved';
  diagnosed_on: string | null; notes: string | null;
  recorded_by_name: string | null; created_at: string; updated_at: string;
}
interface MedicationRow {
  id: string; name: string; dosage: string | null; frequency: string | null;
  started_on: string | null; ended_on: string | null; notes: string | null;
  recorded_by_name: string | null; created_at: string; updated_at: string;
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class PatientHistoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
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

  /* ── allergies ── */

  async listAllergies(patientId: string) {
    return this.tx(async (client) => {
      await this.assertPatient(client, patientId);
      const { rows } = await client.query<AllergyRow>(
        `SELECT a.id, a.substance, a.reaction, a.severity, a.notes,
                u.full_name AS recorded_by_name, a.created_at, a.updated_at
           FROM patient_allergies a
           LEFT JOIN users u ON u.id = a.recorded_by
          WHERE a.patient_id = $1
          ORDER BY CASE a.severity
                     WHEN 'severe' THEN 0 WHEN 'moderate' THEN 1 ELSE 2
                   END,
                   lower(a.substance)`,
        [patientId],
      );
      return rows.map(mapAllergy);
    });
  }

  async createAllergy(patientId: string, dto: CreateAllergyDto, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      await this.assertPatient(client, patientId);
      try {
        const { rows } = await client.query<AllergyRow>(
          `INSERT INTO patient_allergies
             (tenant_id, patient_id, substance, reaction, severity, notes, recorded_by)
           VALUES ($1,$2,btrim($3),$4,$5,$6,$7)
           RETURNING id, substance, reaction, severity, notes,
                     NULL::text AS recorded_by_name, created_at, updated_at`,
          [tenantId, patientId, dto.substance, dto.reaction ?? null,
           dto.severity, dto.notes ?? null, userId],
        );
        return mapAllergy(rows[0]);
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new BadRequestException(
            `An allergy to "${dto.substance.trim()}" is already recorded for this patient`,
          );
        }
        throw err;
      }
    });
  }

  async updateAllergy(id: string, dto: UpdateAllergyDto) {
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
      try {
        const { rows } = await client.query<AllergyRow>(
          `UPDATE patient_allergies SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1
            RETURNING id, substance, reaction, severity, notes,
                      NULL::text AS recorded_by_name, created_at, updated_at`,
          params,
        );
        if (!rows[0]) throw new NotFoundException('Allergy not found');
        return mapAllergy(rows[0]);
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new BadRequestException(
            'That substance is already recorded for this patient',
          );
        }
        throw err;
      }
    });
  }

  async deleteAllergy(id: string) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM patient_allergies WHERE id = $1',
        [id],
      );
      if (!rowCount) throw new NotFoundException('Allergy not found');
      return { deleted: true as const };
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
          WHERE c.patient_id = $1
          ORDER BY (c.status = 'resolved'), c.diagnosed_on DESC NULLS LAST, lower(c.name)`,
        [patientId],
      );
      return rows.map(mapCondition);
    });
  }

  async createCondition(patientId: string, dto: CreateConditionDto, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      await this.assertPatient(client, patientId);
      const { rows } = await client.query<ConditionRow>(
        `INSERT INTO patient_conditions
           (tenant_id, patient_id, name, status, diagnosed_on, notes, recorded_by)
         VALUES ($1,$2,btrim($3),$4,$5,$6,$7)
         RETURNING id, name, status, diagnosed_on, notes,
                   NULL::text AS recorded_by_name, created_at, updated_at`,
        [tenantId, patientId, dto.name, dto.status ?? 'active',
         dto.diagnosedOn || null, dto.notes ?? null, userId],
      );
      return mapCondition(rows[0]);
    });
  }

  async updateCondition(id: string, dto: UpdateConditionDto) {
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
      const { rows } = await client.query<ConditionRow>(
        `UPDATE patient_conditions SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $1
          RETURNING id, name, status, diagnosed_on, notes,
                    NULL::text AS recorded_by_name, created_at, updated_at`,
        params,
      );
      if (!rows[0]) throw new NotFoundException('Condition not found');
      return mapCondition(rows[0]);
    });
  }

  async deleteCondition(id: string) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM patient_conditions WHERE id = $1',
        [id],
      );
      if (!rowCount) throw new NotFoundException('Condition not found');
      return { deleted: true as const };
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
          WHERE m.patient_id = $1
          ORDER BY (m.ended_on IS NOT NULL), m.started_on DESC NULLS LAST, lower(m.name)`,
        [patientId],
      );
      return rows.map(mapMedication);
    });
  }

  async createMedication(patientId: string, dto: CreateMedicationDto, userId: string) {
    assertDateOrder(dto.startedOn, dto.endedOn);
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      await this.assertPatient(client, patientId);
      const { rows } = await client.query<MedicationRow>(
        `INSERT INTO patient_medications
           (tenant_id, patient_id, name, dosage, frequency, started_on, ended_on, notes, recorded_by)
         VALUES ($1,$2,btrim($3),$4,$5,$6,$7,$8,$9)
         RETURNING id, name, dosage, frequency, started_on, ended_on, notes,
                   NULL::text AS recorded_by_name, created_at, updated_at`,
        [tenantId, patientId, dto.name, dto.dosage ?? null, dto.frequency ?? null,
         dto.startedOn || null, dto.endedOn || null, dto.notes ?? null, userId],
      );
      return mapMedication(rows[0]);
    });
  }

  async updateMedication(id: string, dto: UpdateMedicationDto) {
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
      }>('SELECT started_on, ended_on FROM patient_medications WHERE id = $1', [id]);
      if (!existing[0]) throw new NotFoundException('Medication not found');
      assertDateOrder(
        dto.startedOn !== undefined ? dto.startedOn || null : existing[0].started_on,
        dto.endedOn !== undefined ? dto.endedOn || null : existing[0].ended_on,
      );

      const { rows } = await client.query<MedicationRow>(
        `UPDATE patient_medications SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $1
          RETURNING id, name, dosage, frequency, started_on, ended_on, notes,
                    NULL::text AS recorded_by_name, created_at, updated_at`,
        params,
      );
      return mapMedication(rows[0]);
    });
  }

  async deleteMedication(id: string) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM patient_medications WHERE id = $1',
        [id],
      );
      if (!rowCount) throw new NotFoundException('Medication not found');
      return { deleted: true as const };
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

/* ═══════════════════════ controllers ═══════════════════════ */

@Controller('patients/:patientId/history')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientHistoryController {
  constructor(private readonly history: PatientHistoryService) {}

  /** One call for the whole background: allergies, conditions, medications. */
  @Get()
  @RequirePermissions('clinical:read')
  summary(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.history.summary(patientId);
  }
}

@Controller('patients/:patientId/allergies')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AllergiesController {
  constructor(private readonly history: PatientHistoryService) {}

  @Get()
  @RequirePermissions('clinical:read')
  list(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.history.listAllergies(patientId);
  }

  @Post()
  @RequirePermissions('clinical:write')
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateAllergyDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.history.createAllergy(patientId, dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions('clinical:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAllergyDto) {
    return this.history.updateAllergy(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('clinical:write')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.history.deleteAllergy(id);
  }
}

@Controller('patients/:patientId/conditions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ConditionsController {
  constructor(private readonly history: PatientHistoryService) {}

  @Get()
  @RequirePermissions('clinical:read')
  list(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.history.listConditions(patientId);
  }

  @Post()
  @RequirePermissions('clinical:write')
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateConditionDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.history.createCondition(patientId, dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions('clinical:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateConditionDto) {
    return this.history.updateCondition(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('clinical:write')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.history.deleteCondition(id);
  }
}

@Controller('patients/:patientId/medications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MedicationsController {
  constructor(private readonly history: PatientHistoryService) {}

  @Get()
  @RequirePermissions('clinical:read')
  list(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.history.listMedications(patientId);
  }

  @Post()
  @RequirePermissions('clinical:write')
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateMedicationDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.history.createMedication(patientId, dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions('clinical:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMedicationDto) {
    return this.history.updateMedication(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('clinical:write')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.history.deleteMedication(id);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [
    PatientHistoryController,
    AllergiesController,
    ConditionsController,
    MedicationsController,
  ],
  providers: [PatientHistoryService],
  exports: [PatientHistoryService],
})
export class PatientHistoryModule {}
