import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { VAT_CATEGORIES, type VatCategory } from '@dentalcare/shared';

/* ── DTOs ────────────────────────────────────────────────── */
export class CreateTreatmentDto {
  @IsString() @MinLength(2, { message: 'Treatment name is required' })
  name!: string;

  @IsInt() @Min(0) @Max(10_000_000)
  price!: number;

  @IsInt() @Min(5) @Max(600)
  durationMinutes!: number;

  @IsOptional() @IsIn(['single', 'multiple'])
  visitType?: 'single' | 'multiple' | null;

  @IsOptional() @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';

  /** medical: TVSH exempt. cosmetic: the clinic's VAT rate. Medical when omitted. */
  @IsOptional() @IsIn([...VAT_CATEGORIES])
  vatCategory?: VatCategory;
}

export class UpdateTreatmentDto {
  @IsOptional() @IsString() @MinLength(2)
  name?: string;

  @IsOptional() @IsInt() @Min(0) @Max(10_000_000)
  price?: number;

  @IsOptional() @IsInt() @Min(5) @Max(600)
  durationMinutes?: number;

  @IsOptional() @IsIn(['single', 'multiple'])
  visitType?: 'single' | 'multiple' | null;

  @IsOptional() @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';

  @IsOptional() @IsIn([...VAT_CATEGORIES])
  vatCategory?: VatCategory;
}
