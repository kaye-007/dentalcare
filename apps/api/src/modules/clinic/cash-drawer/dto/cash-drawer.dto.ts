import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CURRENCIES, type CurrencyCode } from '@dentalcare/shared';

/* Every amount is an integer of minor units (0006). */

const MAX_AMOUNT = 100_000_000_00;

export class CreateDrawerDto {
  @IsString() @MinLength(1) @MaxLength(60)
  name!: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @IsIn([...CURRENCIES], { each: true })
  currencies!: CurrencyCode[];

  /** The CIS register this drawer's cash is declared on. Omitted: the clinic's register. */
  @IsOptional() @Matches(/^[a-z]{2}[0-9]{3}[a-z]{2}[0-9]{3}$/, { message: 'Register codes look like ab123ab123' })
  tcrCode?: string | null;

  @IsOptional() @IsUUID()
  locationId?: string;
}

export class UpdateDrawerDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60)
  name?: string;

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @IsIn([...CURRENCIES], { each: true })
  currencies?: CurrencyCode[];

  @IsOptional() @Matches(/^[a-z]{2}[0-9]{3}[a-z]{2}[0-9]{3}$/, { message: 'Register codes look like ab123ab123' })
  tcrCode?: string | null;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class ThresholdDto {
  @IsInt() @Min(0) @Max(MAX_AMOUNT)
  tolerance!: number;

  @IsInt() @Min(0) @Max(MAX_AMOUNT)
  approval!: number;
}

export class UpdatePolicyDto {
  @IsOptional() @IsBoolean()
  blindCount?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(3)
  maxRecounts?: number;

  /** Per currency: { "ALL": { tolerance, approval } }. Validated in the service. */
  @IsOptional() @IsObject()
  thresholds?: Record<string, ThresholdDto>;

  /** Per currency: { "ALL": 1000000 }. */
  @IsOptional() @IsObject()
  defaultFloat?: Record<string, number>;
}

export class CurrencyAmountDto {
  @IsIn([...CURRENCIES])
  currency!: CurrencyCode;

  @IsInt() @Min(0) @Max(MAX_AMOUNT)
  amount!: number;

  /** Optional note-by-note count of the float; its total must equal `amount`. */
  @IsOptional() @IsObject()
  denominations?: Record<string, number>;
}

export class OpenSessionDto {
  @IsUUID()
  drawerId!: string;

  /** Omitted currencies take the policy's default float. */
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => CurrencyAmountDto)
  floats?: CurrencyAmountDto[];
}

export class DropDto {
  @IsIn([...CURRENCIES])
  currency!: CurrencyCode;

  @IsInt() @Min(1) @Max(MAX_AMOUNT)
  amount!: number;

  @IsOptional() @IsString() @MaxLength(300)
  reason?: string;
}

export class NoSaleDto {
  @IsString() @MinLength(3) @MaxLength(300)
  reason!: string;
}

/**
 * A manager's approval given at the receptionist's device: who, and their own
 * PIN. Absent when the approver is the one signed in.
 */
export class PinApprovalDto {
  @IsUUID()
  approverUserId!: string;

  @Matches(/^\d{4,8}$/, { message: 'The PIN is 4 to 8 digits' })
  pin!: string;
}

export class ApprovedMovementDto {
  @IsIn([...CURRENCIES])
  currency!: CurrencyCode;

  @IsInt() @Min(1) @Max(MAX_AMOUNT)
  amount!: number;

  @IsString() @MinLength(3) @MaxLength(300)
  reason!: string;

  @IsOptional() @ValidateNested() @Type(() => PinApprovalDto)
  approval?: PinApprovalDto;
}

export class CountEntryDto {
  @IsIn([...CURRENCIES])
  currency!: CurrencyCode;

  @IsObject()
  denominations!: Record<string, number>;
}

export class SubmitCountDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => CountEntryDto)
  counts!: CountEntryDto[];
}

export class CloseSessionDto {
  /** Per currency: the explanation for a variance outside tolerance. */
  @IsOptional() @IsObject()
  notes?: Record<string, string>;

  /** The POS terminal's end-of-day total, when the clinic takes cards. */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT)
  cardBatchTotal?: number;

  @IsOptional() @IsString() @MaxLength(300)
  cardBatchNote?: string;

  /**
   * Unpaid invoices this receptionist raised during the shift stay on the
   * patients' accounts. Required when there are any, so leaving them is a
   * decision rather than an oversight.
   */
  @IsOptional() @IsBoolean()
  acknowledgeOpenInvoices?: boolean;
}

export class ApproveDto {
  @IsString() @MinLength(3) @MaxLength(300)
  reason!: string;
}

export class ApproveWithPinDto extends PinApprovalDto {
  @IsString() @MinLength(3) @MaxLength(300)
  reason!: string;
}

export class ForceCloseDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => CountEntryDto)
  counts!: CountEntryDto[];

  @IsString() @MinLength(10) @MaxLength(300)
  reason!: string;
}

export class SetApprovalPinDto {
  @IsString() @MinLength(1) @MaxLength(200)
  currentPassword!: string;

  @Matches(/^\d{4,8}$/, { message: 'The PIN is 4 to 8 digits' })
  pin!: string;
}

export class ListSessionsQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional() @IsUUID()
  userId?: string;

  @IsOptional() @IsUUID()
  drawerId?: string;

  @IsOptional() @IsIn(['true', 'false'])
  varianceOnly?: string;
}
