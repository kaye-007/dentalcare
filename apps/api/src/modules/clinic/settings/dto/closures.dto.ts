import {
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateClosureDto {
  /** Absent: the whole clinic is closed. Present: that one person is away. */
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @IsISO8601({ strict: true }, { message: 'Start date must be YYYY-MM-DD' })
  startsOn!: string;

  @IsISO8601({ strict: true }, { message: 'End date must be YYYY-MM-DD' })
  endsOn!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  reason!: string;
}
