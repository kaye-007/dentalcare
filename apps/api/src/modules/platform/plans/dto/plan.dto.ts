import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * The code is what subscription invoices snapshot (`plan_code`), so it is set
 * once and never edited: renaming it would leave a year of invoices pointing
 * at a code that no longer exists. The name and the price are the things an
 * operator actually changes.
 */
export const PLAN_CODE = /^[a-z][a-z0-9_]{1,31}$/;

/** A cap well above any real plan, so a slipped digit cannot bill €1M a month. */
const MAX_PRICE_MINOR = 10_000_00;

export class CreatePlanDto {
  @Matches(PLAN_CODE, {
    message:
      'Code must be 2–32 lowercase letters, numbers or underscores, starting with a letter',
  })
  code!: string;

  @IsString()
  @MinLength(2, { message: 'Plan name is required' })
  @MaxLength(60)
  name!: string;

  /** Minor units of euro. */
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE_MINOR)
  priceMonthly!: number;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Plan name is required' })
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE_MINOR)
  priceMonthly?: number;

  /** false retires the plan: no new clinic can be put on it. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
