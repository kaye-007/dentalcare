import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The body of every "withdraw as entered in error" request.
 *
 * A reason is required for the same reason a void requires one: the entry
 * stays in the database, and the reason is the only thing that tells a later
 * reader why a finding vanished from the chart.
 */
export class EnteredInErrorDto {
  @IsString()
  @MinLength(3, { message: 'Say why this entry is wrong — the record keeps your reason' })
  @MaxLength(300)
  reason!: string;
}
