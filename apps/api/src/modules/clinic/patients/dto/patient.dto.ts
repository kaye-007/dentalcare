import {
  REMINDER_CHANNELS,
  WHATSAPP_OPT_IN_SOURCES,
  type ReminderChannelId,
  type WhatsAppOptInSource,
} from '@dentalcare/shared';
import {
  ValidateIf,
  Matches,
  IsBoolean,
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

  /** Personal number or other national identifier. Unique per clinic. */
  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v !== null)
  @Matches(/^[A-Za-z0-9 -]{4,24}$/, { message: 'Enter the national ID as printed, e.g. J12345678A' })
  nationalId?: string | null;

  /** How this patient wants reminders; empty follows the clinic's default. */
  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v !== null)
  @IsIn([...REMINDER_CHANNELS])
  preferredChannel?: ReminderChannelId | '' | null;

  /* ── WhatsApp reminders (0017) ──
     The number reminders go to, when it is not the phone above. Written any
     way the desk types it; stored as E.164. */
  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v !== null)
  @IsString() @MaxLength(40)
  whatsappPhone?: string | null;

  /** The patient agreed to appointment reminders on WhatsApp. */
  @IsOptional() @IsBoolean()
  whatsappOptIn?: boolean;

  /** How the agreement was given. Defaults to in person. */
  @IsOptional() @IsIn([...WHATSAPP_OPT_IN_SOURCES])
  whatsappOptInSource?: WhatsAppOptInSource;

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

  /** The patient does not want appointment reminders. */
  @IsOptional() @IsBoolean()
  remindersOptOut?: boolean;
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
