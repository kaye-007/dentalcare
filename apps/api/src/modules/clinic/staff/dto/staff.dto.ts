import {
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ROLES, Role } from '@dentalcare/shared';

/*
 * Staff = platform access + clinic personnel/payroll tracking.
 *
 * Access roles are EXACTLY two: 'owner' and 'frontdesk'. "Position" is a
 * free-text job title (Dentist, Assistant, Receptionist, Manager, …) — it is
 * descriptive only and grants no permissions.
 *
 * Salary data (amount/note) and the salary payment log are owner-only:
 * frontdesk receives the staff list without payroll fields.
 */

/* ── DTOs ────────────────────────────────────────────────── */
export class CreateStaffDto {
  @IsString()
  @MinLength(2, { message: 'Full name is required' })
  fullName!: string;

  @IsEmail({}, { message: 'Enter a valid email' })
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Temporary password must be at least 8 characters' })
  password!: string;

  @IsIn(ROLES, {
    message: 'Access role must be Admin, Dentist or Receptionist',
  })
  role!: Role;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  position?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  salaryAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  salaryNote?: string;
}

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;

  @IsOptional()
  @IsIn(ROLES, {
    message: 'Access role must be Admin, Dentist or Receptionist',
  })
  role?: Role;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  position?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  salaryAmount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  salaryNote?: string | null;
}

export class ResetStaffPasswordDto {
  @IsString()
  @MinLength(8, { message: 'New password must be at least 8 characters' })
  password!: string;
}

export class RecordSalaryPaymentDto {
  @IsInt()
  @Min(1, { message: 'Amount must be positive' })
  amount!: number;

  @IsOptional()
  @IsISO8601()
  paidOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
