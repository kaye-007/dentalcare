import { TIME_RE } from '../scheduling.types';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';


/* ══════════════════════════ DTOs ══════════════════════════ */

export class CreateOperatoryDto {
  @IsString() @MinLength(1, { message: 'Room name is required' }) @MaxLength(80)
  name!: string;

  @IsOptional() @IsString() @MaxLength(200)
  description?: string;

  @IsOptional() @IsInt() @Min(0) @Max(999)
  sortOrder?: number;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Colour must be a hex value like #2f6f62' })
  color?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class UpdateOperatoryDto extends CreateOperatoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80)
  declare name: string;
}

export class CreateAvailabilityDto {
  @IsUUID()
  staffId!: string;

  @IsInt() @Min(0, { message: 'Weekday must be 0 (Sunday) to 6 (Saturday)' })
  @Max(6, { message: 'Weekday must be 0 (Sunday) to 6 (Saturday)' })
  weekday!: number;

  @Matches(TIME_RE, { message: 'Start time must be HH:MM' })
  startsAt!: string;

  @Matches(TIME_RE, { message: 'End time must be HH:MM' })
  endsAt!: string;

  @IsOptional() @IsUUID()
  operatoryId?: string;
}

export class UpdateAvailabilityDto {
  @IsOptional() @IsInt() @Min(0) @Max(6)
  weekday?: number;

  @IsOptional() @Matches(TIME_RE, { message: 'Start time must be HH:MM' })
  startsAt?: string;

  @IsOptional() @Matches(TIME_RE, { message: 'End time must be HH:MM' })
  endsAt?: string;

  @IsOptional() @IsUUID()
  operatoryId?: string | null;
}

/** The room a practitioner's bookings start in; null clears it. */
export class SetHomeRoomDto {
  @IsOptional() @IsUUID()
  operatoryId?: string | null;
}
