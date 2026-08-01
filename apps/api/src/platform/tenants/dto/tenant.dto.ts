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
