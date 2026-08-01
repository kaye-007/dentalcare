import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateAppointmentDto {
  @IsUUID()
  patientId!: string;

  @IsOptional()
  @IsUUID()
  staffId?: string;

  @IsISO8601()
  startsAt!: string;

  @IsISO8601()
  endsAt!: string;

  @IsString()
  @MinLength(1, { message: 'Reason is required' })
  @MaxLength(200)
  reason!: string;
}

export class UpdateAppointmentDto {
  @IsOptional() @IsUUID()
  patientId?: string;

  @IsOptional() @IsUUID()
  staffId?: string | null;

  @IsOptional() @IsISO8601()
  startsAt?: string;

  @IsOptional() @IsISO8601()
  endsAt?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(200)
  reason?: string;

  @IsOptional() @IsIn(['scheduled', 'completed', 'cancelled', 'no_show'])
  status?: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
}
