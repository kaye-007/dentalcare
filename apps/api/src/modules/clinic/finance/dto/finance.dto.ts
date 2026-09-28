import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type as TT } from 'class-transformer';
import { VAT_CATEGORIES, type VatCategory } from '@dentalcare/shared';

/* ════════ DTOs ════════
 * Every amount here is an integer of MINOR units — cents — in the clinic's
 * currency (migration 0006). 3750 is €37.50. */
export class LineItemDto {
  @IsOptional()
  @IsUUID()
  treatmentId?: string;

  @IsString()
  @MinLength(1, { message: 'Line description is required' })
  @MaxLength(200)
  description!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsInt()
  @Min(0)
  unitPrice!: number;

  /**
   * TVSH for this line. Omitted: the treatment's own category, or medical
   * (exempt) for a line that names no treatment.
   */
  @IsOptional()
  @IsIn([...VAT_CATEGORIES])
  vatCategory?: VatCategory;

  /**
   * The charted procedure this line bills. The server checks it belongs to
   * the patient, is completed and is not already on a live invoice, and
   * takes the tooth from it; the price stays what reception agreed.
   */
  @IsOptional()
  @IsUUID()
  procedureId?: string;
}

export class CreateInvoiceDto {
  @IsUUID()
  patientId!: string;

  @IsOptional()
  @IsISO8601()
  issuedAt?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'An invoice needs at least one line item' })
  @ValidateNested({ each: true })
  @TT(() => LineItemDto)
  items!: LineItemDto[];
}

export class RecordPaymentDto {
  @IsInt()
  @Min(1, { message: 'Amount must be positive' })
  amount!: number;

  /** The kind. Optional when `methodId` names one of the clinic's own methods. */
  @IsOptional()
  @IsIn(['cash', 'card', 'bank'])
  method?: 'cash' | 'card' | 'bank';

  /** One of the clinic's payment methods (Settings); its kind wins over `method`. */
  @IsOptional()
  @Matches(/^[a-z0-9-]{1,40}$/)
  methodId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  /**
   * Which document this payment issues (0015):
   *
   *   fiscal    faturë e fiskalizuar — registered with the tax authority
   *             straight after the payment, which returns the NIVF
   *   internal  faturë fiktive — the clinic's own receipt, never sent to DPT
   *
   * Omitted: the clinic's default, or its last choice for this invoice.
   */
  @IsOptional()
  @IsIn(['internal', 'fiscal'])
  document?: 'internal' | 'fiscal';
}

export class CreateExpenseDto {
  @IsIn(['rent', 'materials', 'utilities', 'salaries', 'lab', 'other'])
  category!: 'rent' | 'materials' | 'utilities' | 'salaries' | 'lab' | 'other';

  @IsInt()
  @Min(1)
  amount!: number;

  @IsOptional()
  @IsISO8601()
  expenseDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/**
 * Voiding requires a reason, and MinLength(3) is not decoration: "the record
 * says who reversed it" is worth little if the why can be a single keystroke.
 */
export class VoidDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}
