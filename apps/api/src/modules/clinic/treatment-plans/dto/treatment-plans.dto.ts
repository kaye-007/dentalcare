import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ALL_TEETH, SURFACES, type Surface } from '@/modules/clinic/charting';
import { PLAN_STATUSES, type PlanStatus } from '../cost-engine';

/**
 * Treatment plans: a priced proposal assembled from procedures, tracked from
 * draft through to delivery.
 *
 * Costs are never stored as a total. Every read recomputes from the lines via
 * the cost engine, so a stored total can never drift from the lines it claims
 * to summarise — the classic failure of quoting systems, and the one a patient
 * notices.
 */

/* ══════════════════════════ DTOs ══════════════════════════ */

export class CreatePlanDto {
  @IsString()
  @MinLength(1, { message: 'Give the plan a title' })
  @MaxLength(150)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsOptional()
  @IsUUID()
  dentistId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  discountAmount?: number;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsOptional()
  @IsUUID()
  dentistId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  discountAmount?: number;
}

export class TransitionPlanDto {
  @IsIn(PLAN_STATUSES as unknown as string[], {
    message: `Status must be one of: ${PLAN_STATUSES.join(', ')}`,
  })
  status!: PlanStatus;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class CreatePlanItemDto {
  @IsOptional()
  @IsInt()
  @IsIn(ALL_TEETH as number[], {
    message: 'Not a valid FDI tooth number',
  })
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
  treatmentId?: string;

  @IsString()
  @MinLength(1, { message: 'Describe the procedure' })
  @MaxLength(300)
  description!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  quantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  unitFee?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  discountAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class UpdatePlanItemDto extends CreatePlanItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  declare description: string;

  @IsOptional()
  @IsIn(['planned', 'scheduled', 'completed', 'cancelled'])
  status?: 'planned' | 'scheduled' | 'completed' | 'cancelled';
}
