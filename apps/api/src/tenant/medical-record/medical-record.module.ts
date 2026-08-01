import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessTokenPayload } from '../auth/auth.service';
import { AuthModule } from '../auth/auth.module';

/* ── DTOs ────────────────────────────────────────────────── */
export class CreateRecordDto {
  @IsInt()
  tooth!: number;

  @IsString() @MinLength(2, { message: 'Condition is required' }) @MaxLength(120)
  condition!: string;

  @IsOptional() @IsUUID()
  treatmentId?: string;

  @IsOptional() @IsUUID()
  dentistId?: string;

  @IsOptional() @IsIn(['pending', 'done'])
  status?: 'pending' | 'done';

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

export class UpdateRecordDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  condition?: string;

  @IsOptional() @IsUUID()
  treatmentId?: string;

  @IsOptional() @IsUUID()
  dentistId?: string;

  @IsOptional() @IsIn(['pending', 'done'])
  status?: 'pending' | 'done';

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

/* ── service ─────────────────────────────────────────────── */
const FDI_VALID = (t: number) =>
  (t >= 11 && t <= 18) || (t >= 21 && t <= 28) || (t >= 31 && t <= 38) || (t >= 41 && t <= 48);

interface RecRow {
  id: string;
  tooth: number;
  condition: string;
  status: string;
  note: string | null;
  recorded_at: string;
  treatment_id: string | null;
  treatment_name: string | null;
  dentist_id: string | null;
  dentist_name: string | null;
}

const SELECT = `
  SELECT r.id, r.tooth, r.condition, r.status, r.note, r.recorded_at,
         r.treatment_id, t.name AS treatment_name,
         r.dentist_id, u.full_name AS dentist_name
    FROM tooth_records r
    LEFT JOIN treatments t ON t.id = r.treatment_id
    LEFT JOIN users u ON u.id = r.dentist_id`;

const map = (r: RecRow) => ({
  id: r.id,
  tooth: r.tooth,
  condition: r.condition,
  status: r.status,
  note: r.note,
  recordedAt: r.recorded_at,
  treatmentId: r.treatment_id,
  treatmentName: r.treatment_name,
  dentistId: r.dentist_id,
  dentistName: r.dentist_name,
});

@Injectable()
export class MedicalRecordService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  listForPatient(patientId: string) {
    return this.tx(async (client) => {
      const exists = await client.query('SELECT 1 FROM patients WHERE id = $1', [patientId]);
      if (!exists.rowCount) throw new NotFoundException('Patient not found');
      const { rows } = await client.query<RecRow>(
        `${SELECT} WHERE r.patient_id = $1 ORDER BY r.tooth, r.recorded_at DESC`,
        [patientId],
      );
      return rows.map(map);
    });
  }

  create(patientId: string, dto: CreateRecordDto, userId: string) {
    if (!FDI_VALID(dto.tooth)) {
      throw new BadRequestException('Tooth must be a valid FDI number (11–18, 21–28, 31–38, 41–48)');
    }
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const exists = await client.query('SELECT 1 FROM patients WHERE id = $1', [patientId]);
      if (!exists.rowCount) throw new NotFoundException('Patient not found');
      if (dto.treatmentId) {
        const t = await client.query('SELECT 1 FROM treatments WHERE id = $1', [dto.treatmentId]);
        if (!t.rowCount) throw new NotFoundException('Treatment not found');
      }
      if (dto.dentistId) {
        const d = await client.query('SELECT 1 FROM users WHERE id = $1', [dto.dentistId]);
        if (!d.rowCount) throw new NotFoundException('Dentist not found');
      }
      const ins = await client.query<{ id: string }>(
        `INSERT INTO tooth_records
           (tenant_id, patient_id, tooth, condition, treatment_id, dentist_id, status, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [tenantId, patientId, dto.tooth, dto.condition, dto.treatmentId ?? null,
         dto.dentistId ?? null, dto.status ?? 'pending', dto.note ?? null, userId],
      );
      const { rows } = await client.query<RecRow>(`${SELECT} WHERE r.id = $1`, [ins.rows[0]!.id]);
      return map(rows[0]!);
    });
  }

  update(recordId: string, dto: UpdateRecordDto) {
    const cols: Record<string, string> = {
      condition: 'condition',
      treatmentId: 'treatment_id',
      dentistId: 'dentist_id',
      status: 'status',
      note: 'note',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      const v = (dto as unknown as Record<string, unknown>)[k];
      if (v !== undefined) {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
    }
    return this.tx(async (client) => {
      if (!sets.length) {
        const r = await client.query<RecRow>(`${SELECT} WHERE r.id = $1`, [recordId]);
        if (!r.rows[0]) throw new NotFoundException('Record not found');
        return map(r.rows[0]);
      }
      params.push(recordId);
      const upd = await client.query(
        `UPDATE tooth_records SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params,
      );
      if (!upd.rowCount) throw new NotFoundException('Record not found');
      const { rows } = await client.query<RecRow>(`${SELECT} WHERE r.id = $1`, [recordId]);
      return map(rows[0]!);
    });
  }
}

/* ── controller ──────────────────────────────────────────── */
@Controller()
@UseGuards(JwtAuthGuard)
export class MedicalRecordController {
  constructor(private readonly records: MedicalRecordService) {}

  @Get('patients/:patientId/medical-record')
  list(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.records.listForPatient(patientId);
  }

  @Post('patients/:patientId/medical-record')
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateRecordDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.records.create(patientId, dto, user.sub);
  }

  @Patch('medical-record/:recordId')
  update(@Param('recordId', ParseUUIDPipe) recordId: string, @Body() dto: UpdateRecordDto) {
    return this.records.update(recordId, dto);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [MedicalRecordController],
  providers: [MedicalRecordService],
})
export class MedicalRecordModule {}
