import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { LAB_STATUSES, type LabStatus } from '../lab-status';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'Enter the date as YYYY-MM-DD';
/** A lab bill in minor units; generous, but not unbounded. */
const MAX_COST = 100_000_000;

export class CreateLabOrderDto {
  @IsUUID()
  patientId!: string;

  /** What the lab makes: "E-max crown", "Night guard", "Partial denture". */
  @IsString()
  @MinLength(2, { message: 'Say what the lab is making' })
  @MaxLength(200)
  work!: string;

  /** FDI tooth numbers. Empty for an appliance that is not one tooth's. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsInt({ each: true })
  @Min(11, { each: true })
  @Max(85, { each: true })
  teeth?: number[];

  @IsOptional()
  @IsUUID()
  labId?: string;

  @IsOptional()
  @IsUUID()
  dentistId?: string;

  /** The treatment plan line this work delivers. */
  @IsOptional()
  @IsUUID()
  planItemId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  material?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  shade?: string;

  /** What the lab charges, in minor units. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_COST)
  cost?: number;

  @IsOptional()
  @Matches(ISO_DATE, { message: DATE_MESSAGE })
  dueOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/** Every field may change after ordering, except whose work it is. null clears. */
export class UpdateLabOrderDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Say what the lab is making' })
  @MaxLength(200)
  work?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsInt({ each: true })
  @Min(11, { each: true })
  @Max(85, { each: true })
  teeth?: number[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  labId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  dentistId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  planItemId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(80)
  material?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20)
  shade?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_COST)
  cost?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(ISO_DATE, { message: DATE_MESSAGE })
  dueOn?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

/** One step along — or back, to undo a tap — or cancelled with a reason. */
export class MoveLabOrderDto {
  @IsIn(LAB_STATUSES, { message: `Status must be one of: ${LAB_STATUSES.join(', ')}` })
  status!: LabStatus;

  /** Required when cancelling. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
