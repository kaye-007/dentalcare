import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Structured medical history: allergies, conditions and medications.
 *
 * Kept out of `medical-record/` on purpose — that module is the odontogram,
 * which is per-tooth and per-visit. This is patient-level background that a
 * clinician must see BEFORE touching a tooth, and that the front desk must be
 * able to read (to warn a dentist) without being able to edit.
 *
 * Reads need `clinical:read`, writes need `clinical:write`. Under the Phase 1
 * matrix that means every role can read an allergy, and only admin and
 * dentist can record or change one.
 */

/* ══════════════════════════ DTOs ══════════════════════════ */

export class CreateAllergyDto {
  @IsString()
  @MinLength(1, { message: 'Substance is required' })
  @MaxLength(120)
  substance!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reaction?: string;

  @IsIn(['mild', 'moderate', 'severe'], {
    message: 'Severity must be mild, moderate or severe',
  })
  severity!: 'mild' | 'moderate' | 'severe';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateAllergyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  substance?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reaction?: string;

  @IsOptional()
  @IsIn(['mild', 'moderate', 'severe'])
  severity?: 'mild' | 'moderate' | 'severe';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CreateConditionDto {
  @IsString()
  @MinLength(1, { message: 'Condition name is required' })
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsIn(['active', 'resolved'])
  status?: 'active' | 'resolved';

  @IsOptional()
  @IsISO8601({}, { message: 'Diagnosed date must be a valid date' })
  diagnosedOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateConditionDto extends CreateConditionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  declare name: string;
}

export class CreateMedicationDto {
  @IsString()
  @MinLength(1, { message: 'Medication name is required' })
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  dosage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  frequency?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'Start date must be a valid date' })
  startedOn?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'End date must be a valid date' })
  endedOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateMedicationDto extends CreateMedicationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  declare name: string;
}
