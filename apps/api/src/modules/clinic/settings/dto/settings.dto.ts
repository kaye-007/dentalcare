import { WorkingDay } from '../settings.types';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';


export class UpdateSettingsDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  clinicName?: string;

  @IsOptional() @IsString() @MaxLength(200)
  address?: string;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsEmail({}, { message: 'Enter a valid clinic email' })
  email?: string;

  @IsOptional() @IsArray()
  workingHours?: WorkingDay[];

  @IsOptional() @IsInt() @Min(15) @Max(240)
  defaultAppointmentDuration?: number;

  @IsOptional() @IsBoolean()
  remindersEnabled?: boolean;

  @IsOptional() @IsInt() @Min(1) @Max(168)
  reminderHoursBefore?: number;

  @IsOptional() @IsBoolean()
  payrollLoggingEnabled?: boolean;
}
