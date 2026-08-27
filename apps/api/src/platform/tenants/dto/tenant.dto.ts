import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @MinLength(2, { message: 'Clinic name is required' })
  clinicName!: string;

  @Matches(/^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$/, {
    message: 'Subdomain must be lowercase letters, numbers, or hyphens',
  })
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
}

export class UpdateTenantStatusDto {
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
