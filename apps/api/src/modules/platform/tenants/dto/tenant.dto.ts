import { CURRENCIES, type CurrencyCode } from '@dentalcare/shared';
import {
  IsEmail,
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

export const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$/;
const SUBDOMAIN_MESSAGE = 'Subdomain must be 3–30 lowercase letters, numbers, or hyphens';

export class CreateTenantDto {
  @IsString()
  @MinLength(2, { message: 'Clinic name is required' })
  clinicName!: string;

  @Matches(SUBDOMAIN, { message: SUBDOMAIN_MESSAGE })
  subdomain!: string;

  @IsString()
  @MinLength(2, { message: 'Owner name is required' })
  ownerFullName!: string;

  @IsEmail({}, { message: 'Enter a valid owner email' })
  ownerEmail!: string;

  @IsString()
  @MinLength(8, { message: 'Temporary password must be at least 8 characters' })
  ownerPassword!: string;

  @IsOptional()
  @IsUUID()
  planId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  trialDays?: number;

  /* ── the clinic's first settings, so the owner signs in to a working clinic ── */

  @IsOptional()
  @IsIn(CURRENCIES as unknown as string[])
  currency?: CurrencyCode;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @Matches(/^[1-9]\d{0,2}$/, { message: 'Country code without + or 00, e.g. 355' })
  phoneCountryCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @Matches(/^[A-Za-z0-9 -]{5,20}$/, { message: 'Enter the NIPT as printed' })
  taxNumber?: string;
}

export class UpdateTenantStatusDto {
  /** 'deleted' is not settable here: deletion has its own confirmed route. */
  @IsIn(['active', 'suspended', 'archived'])
  status!: 'active' | 'suspended' | 'archived';
}

export class SetTrialDto {
  /**
   * Days from now. `null` converts the clinic to paid and lifts the read-only
   * lock — the difference between "give them another week" and "they bought
   * it" is this one field, so it is explicitly nullable rather than optional:
   * a missing field would be indistinguishable from a deliberate conversion.
   */
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(365)
  days!: number | null;
}

export class ResetUserPasswordDto {
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password!: string;
}

export class SetPlanDto {
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  planId!: string | null;
}

export class ChangeSubdomainDto {
  @Matches(SUBDOMAIN, { message: SUBDOMAIN_MESSAGE })
  subdomain!: string;
}

export class DeleteTenantDto {
  /** The clinic's subdomain, typed again. A confirmation a click cannot give. */
  @IsString()
  confirmSubdomain!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}
