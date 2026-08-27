import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { APPOINTMENT_STATUSES, AppointmentStatus } from '../status-machine';

export class CreateAppointmentDto {
  @IsUUID()
  patientId!: string;

  @IsOptional() @IsUUID()
  staffId?: string;

  /** Treatment room. Optional: not every clinic assigns chairs. */
  @IsOptional() @IsUUID()
  operatoryId?: string;

  @IsISO8601()
  startsAt!: string;

  @IsISO8601()
  endsAt!: string;

  @IsString() @MinLength(1, { message: 'Reason is required' }) @MaxLength(200)
  reason!: string;
}

/**
 * Details and timing only. Status changes go through
 * `POST /appointments/:id/status` so the state machine and the audit trail
 * cannot be bypassed.
 */
export class UpdateAppointmentDto {
  @IsOptional() @IsUUID()
  patientId?: string;

  @IsOptional() @IsUUID()
  staffId?: string | null;

  @IsOptional() @IsUUID()
  operatoryId?: string | null;

  @IsOptional() @IsISO8601()
  startsAt?: string;

  @IsOptional() @IsISO8601()
  endsAt?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(200)
  reason?: string;
}

export class TransitionStatusDto {
  @IsIn(APPOINTMENT_STATUSES, {
    message: `Status must be one of: ${APPOINTMENT_STATUSES.join(', ')}`,
  })
  status!: AppointmentStatus;

  /** Mandatory when cancelling — a cancellation with no reason is a mystery. */
  @IsOptional() @IsString() @MaxLength(300)
  reason?: string;

  /** Free-form context recorded on the audit row. */
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}
