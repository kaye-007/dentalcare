import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Session and second-factor request bodies, shared by both planes.
 *
 * In shared/ rather than in either auth module because the clinic and the
 * console speak exactly the same protocol for these steps, and a console
 * controller importing from modules/clinic/auth would couple the two planes
 * for the sake of five classes.
 */

export class RefreshDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  refreshToken!: string;
}

/** Continues a sign-in that stopped for a second factor. */
export class ChallengeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  challengeToken!: string;
}

/**
 * The second step of a sign-in: a code from the authenticator app, OR one
 * recovery code. Which one is present is checked in the service, because
 * "exactly one of two optional fields" is clearer there than in decorators.
 */
export class VerifyMfaDto extends ChallengeDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  recoveryCode?: string;
}

export class ConfirmEnrollmentDto extends ChallengeDto {
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code!: string;
}

export class MfaCodeDto {
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code!: string;
}
