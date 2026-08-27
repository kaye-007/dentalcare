import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { type LedgerEntryType } from '@/modules/clinic/finance';

/* ══════════════════════════ DTOs ══════════════════════════ */

export class GenerateInvoiceDto {
  /**
   * By default only COMPLETED plan lines are billed — a clinic should not
   * invoice work it has not done. Set false to bill the whole plan up front,
   * which some clinics do for orthodontics.
   */
  @IsOptional() @IsBoolean()
  completedOnly?: boolean;

  @IsOptional() @IsISO8601()
  issuedAt?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string;
}

export class LedgerAdjustmentDto {
  @IsIn(['adjustment', 'write_off', 'refund'], {
    message: 'Type must be adjustment, write_off or refund',
  })
  entryType!: Extract<LedgerEntryType, 'adjustment' | 'write_off' | 'refund'>;

  /**
   * Always POSITIVE. The service applies the sign from the entry type, so a
   * caller cannot accidentally invert a write-off into a charge.
   */
  @IsInt()
  amount!: number;

  @IsString() @MinLength(1, { message: 'Say why this adjustment was made' }) @MaxLength(300)
  description!: string;

  @IsOptional() @IsISO8601()
  occurredOn?: string;
}
