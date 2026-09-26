import { IsEmail, IsString, MinLength } from 'class-validator';
import { MfaCodeDto } from '@/shared/dto/auth.dto';

export {
  ChallengeDto,
  ConfirmEnrollmentDto,
  MfaCodeDto,
  RefreshDto,
  VerifyMfaDto,
} from '@/shared/dto/auth.dto';

export class LoginDto {
  @IsEmail({}, { message: 'Enter a valid email address' })
  email!: string;

  @IsString()
  @MinLength(1, { message: 'Password is required' })
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1, { message: 'Current password is required' })
  currentPassword!: string;

  @IsString()
  @MinLength(8, { message: 'New password must be at least 8 characters' })
  newPassword!: string;
}

/** Turning two-step sign-in off takes the password AND a current code. */
export class DisableMfaDto extends MfaCodeDto {
  @IsString()
  @MinLength(1, { message: 'Your password is required' })
  password!: string;
}
