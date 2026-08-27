import {
  ValidateIf,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreatePatientDto {
  @IsString() @MinLength(1, { message: 'First name is required' })
  firstName!: string;

  @IsString() @MinLength(1, { message: 'Last name is required' })
  lastName!: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v !== null)
  @IsEmail({}, { message: 'Enter a valid email' })
  email?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v !== null)
  @IsIn(['male', 'female', 'other'])
  gender?: 'male' | 'female' | 'other';

  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v !== null)
  @IsISO8601({}, { message: 'Birth date must be a valid date' })
  birthDate?: string;

  @IsOptional() @IsString() @MaxLength(200)
  address?: string;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @IsString() @MaxLength(20)
  postalCode?: string;

  @IsOptional() @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive' | 'archived';

  /* ── emergency contact ──
     A name without a phone number is unusable in an emergency, and the
     database enforces the same rule via patients_emergency_contact_usable. */
  @IsOptional() @IsString() @MaxLength(120)
  emergencyContactName?: string;

  @IsOptional() @IsString() @MaxLength(60)
  emergencyContactRelationship?: string;

  @IsOptional() @IsString() @MaxLength(40)
  emergencyContactPhone?: string;
}

export class UpdatePatientDto extends CreatePatientDto {
  @IsOptional() @IsString() @MinLength(1)
  declare firstName: string;

  @IsOptional() @IsString() @MinLength(1)
  declare lastName: string;
}

export class ArchivePatientDto {
  /** Why the record was archived. Recorded for audit; optional but urged. */
  @IsOptional() @IsString() @MaxLength(300)
  reason?: string;
}

export class CreateNoteDto {
  @IsString() @MinLength(1, { message: 'Note cannot be empty' }) @MaxLength(2000)
  body!: string;
}
