import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type as TT } from 'class-transformer';

/* ════════ DTOs ════════ */
export class LineItemDto {
  @IsOptional() @IsUUID()
  treatmentId?: string;

  @IsString() @MinLength(1, { message: 'Line description is required' }) @MaxLength(200)
  description!: string;

  @IsInt() @Min(1)
  quantity!: number;

  @IsInt() @Min(0)
  unitPrice!: number;
}

export class CreateInvoiceDto {
  @IsUUID()
  patientId!: string;

  @IsOptional() @IsISO8601()
  issuedAt?: string;

  @IsArray() @ArrayMinSize(1, { message: 'An invoice needs at least one line item' })
  @ValidateNested({ each: true }) @TT(() => LineItemDto)
  items!: LineItemDto[];
}

export class RecordPaymentDto {
  @IsInt() @Min(1, { message: 'Amount must be positive' })
  amount!: number;

  @IsIn(['cash', 'card', 'bank'])
  method!: 'cash' | 'card' | 'bank';

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

export class CreateExpenseDto {
  @IsIn(['rent', 'materials', 'utilities', 'salaries', 'lab', 'other'])
  category!: 'rent' | 'materials' | 'utilities' | 'salaries' | 'lab' | 'other';

  @IsInt() @Min(1)
  amount!: number;

  @IsOptional() @IsISO8601()
  expenseDate?: string;

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

/**
 * Voiding requires a reason, and MinLength(3) is not decoration: "the record
 * says who reversed it" is worth little if the why can be a single keystroke.
 */
export class VoidDto {
  @IsString() @MinLength(3) @MaxLength(300)
  reason!: string;
}
