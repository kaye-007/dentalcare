import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ALL_TEETH,
  SURFACES,
  TOOTH_CONDITIONS,
  VAT_CATEGORIES,
  type VatCategory,
  type Surface,
  type ToothCondition,
} from '@dentalcare/shared';

/* ══════════════════════════ DTOs ══════════════════════════ */

export class CreateToothConditionDto {
  @IsInt()
  @IsIn(ALL_TEETH as number[], { message: 'Not a valid FDI tooth number' })
  tooth!: number;

  /** Omit for a whole-tooth finding such as an extraction. */
  @IsOptional()
  @IsIn(SURFACES as unknown as string[])
  surface?: Surface;

  @IsIn(TOOTH_CONDITIONS as unknown as string[], {
    message: `Condition must be one of: ${TOOTH_CONDITIONS.join(', ')}`,
  })
  condition!: ToothCondition;

  @IsOptional()
  @IsIn(['active', 'treated', 'resolved'])
  status?: 'active' | 'treated' | 'resolved';

  @IsOptional()
  @IsUUID()
  dentistId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateToothConditionDto {
  @IsOptional()
  @IsIn(['active', 'treated', 'resolved'])
  status?: 'active' | 'treated' | 'resolved';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsUUID()
  dentistId?: string;
}

export class CreateProcedureCodeDto {
  @IsIn(['CDT', 'ICD10', 'custom'])
  system!: 'CDT' | 'ICD10' | 'custom';

  @IsString()
  @MinLength(1)
  @MaxLength(20)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  description!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  defaultFee?: number;

  @IsOptional()
  @IsUUID()
  treatmentId?: string;

  /** TVSH on plan invoices: medical is exempt, cosmetic carries the clinic rate. */
  @IsOptional()
  @IsIn([...VAT_CATEGORIES])
  vatCategory?: VatCategory;
}

export class UpdateProcedureCodeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  defaultFee?: number;

  @IsOptional()
  @IsUUID()
  treatmentId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsIn([...VAT_CATEGORIES])
  vatCategory?: VatCategory;
}

export class CreateProcedureDto {
  @IsOptional()
  @IsInt()
  @IsIn(ALL_TEETH as number[])
  tooth?: number;

  @IsOptional()
  @IsArray()
  @IsIn(SURFACES as unknown as string[], { each: true })
  surfaces?: Surface[];

  @IsOptional()
  @IsUUID()
  procedureCodeId?: string;

  @IsOptional()
  @IsUUID()
  diagnosisCodeId?: string;

  @IsOptional()
  @IsUUID()
  treatmentId?: string;

  @IsOptional()
  @IsUUID()
  planItemId?: string;

  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  description!: string;

  @IsOptional()
  @IsUUID()
  clinicianId?: string;

  @IsOptional()
  @IsIn(['planned', 'in_progress', 'completed', 'cancelled'])
  status?: 'planned' | 'in_progress' | 'completed' | 'cancelled';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  fee?: number;

  @IsOptional()
  @IsISO8601()
  performedOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /**
   * Tooth conditions this procedure treats. They are marked 'treated' and
   * pointed at the procedure, so the chart shows the finding as addressed
   * rather than leaving stale caries beside a completed filling.
   */
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  resolvesConditionIds?: string[];
}

export class UpdateProcedureDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsIn(['planned', 'in_progress', 'completed', 'cancelled'])
  status?: 'planned' | 'in_progress' | 'completed' | 'cancelled';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  fee?: number;

  @IsOptional()
  @IsISO8601()
  performedOn?: string;

  @IsOptional()
  @IsUUID()
  clinicianId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
