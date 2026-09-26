import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Length, Min } from 'class-validator';

export const PAYMENT_METHODS = ['bank_transfer', 'card', 'cash', 'other'] as const;

export class RunBillingDto {
  /**
   * Any date inside the month to bill; the service truncates to the month.
   * Omitted means today, which is what the console's button sends.
   */
  @IsOptional()
  @IsISO8601()
  period?: string;
}

export class MarkPaidDto {
  @IsIn(PAYMENT_METHODS)
  method!: (typeof PAYMENT_METHODS)[number];

  /** Omitted means the invoice was settled in full. */
  @IsOptional()
  @IsInt()
  @Min(0)
  amount?: number;

  /** For money that arrived before someone got round to recording it. */
  @IsOptional()
  @IsISO8601()
  paidAt?: string;

  /** Bank reference, transaction id — whatever makes this findable again. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  reference?: string;

  @IsOptional()
  @IsString()
  @Length(1, 1000)
  note?: string;
}

export class VoidInvoiceDto {
  /** Required: a voided invoice with no stated reason is an unanswered question. */
  @IsString()
  @Length(3, 1000)
  reason!: string;
}
