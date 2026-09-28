import { PERIO_SITES, PerioSite } from '../perio.types';
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
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ALL_TEETH } from '@/modules/clinic/charting';

/* ══════════════════════════ DTOs ══════════════════════════ */

export class PerioMeasurementDto {
  @IsInt()
  @IsIn(ALL_TEETH as number[], { message: 'Not a valid FDI tooth number' })
  tooth!: number;

  @IsIn(PERIO_SITES as unknown as string[], {
    message: `Site must be one of: ${PERIO_SITES.join(', ')}`,
  })
  site!: PerioSite;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(15)
  probingDepth?: number | null;

  /** Negative means tissue sits coronal to the CEJ (overgrowth). */
  @IsOptional()
  @IsInt()
  @Min(-5)
  @Max(15)
  recession?: number | null;

  @IsOptional()
  @IsBoolean()
  bleeding?: boolean;

  @IsOptional()
  @IsBoolean()
  suppuration?: boolean;

  @IsOptional()
  @IsBoolean()
  plaque?: boolean;
}

export class PerioToothFindingDto {
  @IsInt()
  @IsIn(ALL_TEETH as number[])
  tooth!: number;

  /** Miller mobility 0–3. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  mobility?: number | null;

  /** Glickman furcation 0–3. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  furcation?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class CreatePerioExamDto {
  @IsOptional()
  @IsISO8601()
  examinedOn?: string;

  @IsOptional()
  @IsUUID()
  clinicianId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class SaveMeasurementsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PerioMeasurementDto)
  measurements!: PerioMeasurementDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PerioToothFindingDto)
  findings?: PerioToothFindingDto[];
}
