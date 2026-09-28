import {
  Body,
  Controller,
  Get,
  Headers,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService, RequestMeta } from './auth.service';
import {
  ChallengeDto,
  ChangePasswordDto,
  ConfirmEnrollmentDto,
  DisableMfaDto,
  LoginDto,
  MfaCodeDto,
  RefreshDto,
  VerifyMfaDto,
} from './dto/login.dto';
import { JwtAuthGuard } from './jwt.guard';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '../../../shared/types/access-token';
import { AllowWhenReadOnly } from '@/core/tenancy/read-only.guard';

const meta = (userAgent?: string, ip?: string): RequestMeta => ({ userAgent, ip });

function signedIn(user?: AccessTokenPayload): AccessTokenPayload {
  if (!user) throw new UnauthorizedException();
  return user;
}

/**
 * Every route here is allowed after a trial expires. Withholding writes is a
 * payment lever; withholding someone's ability to sign in, sign out, rotate a
 * password or protect their account is a security regression, and the two
 * must not be confused because they share an HTTP verb.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Credential endpoint: tight per-IP ceiling to blunt credential stuffing.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWhenReadOnly()
  @Post('login')
  login(@Body() dto: LoginDto, @Headers('user-agent') ua?: string, @Ip() ip?: string) {
    return this.auth.login(dto.email, dto.password, meta(ua, ip));
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @AllowWhenReadOnly()
  @Post('refresh')
  refresh(
    @Body() dto: RefreshDto,
    @Headers('user-agent') ua?: string,
    @Ip() ip?: string,
  ) {
    return this.auth.refresh(dto.refreshToken, meta(ua, ip));
  }

  /** Needs no access token: holding the refresh token is the authority to end it. */
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @AllowWhenReadOnly()
  @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  /* ── the second step of a sign-in ── */

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWhenReadOnly()
  @Post('mfa/verify')
  verifyMfa(
    @Body() dto: VerifyMfaDto,
    @Headers('user-agent') ua?: string,
    @Ip() ip?: string,
  ) {
    return this.auth.verifyMfa(
      dto.challengeToken,
      { code: dto.code, recoveryCode: dto.recoveryCode },
      meta(ua, ip),
    );
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWhenReadOnly()
  @Post('mfa/enroll/start')
  beginEnrollment(@Body() dto: ChallengeDto) {
    return this.auth.beginEnrollment(dto.challengeToken);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWhenReadOnly()
  @Post('mfa/enroll/confirm')
  confirmEnrollment(
    @Body() dto: ConfirmEnrollmentDto,
    @Headers('user-agent') ua?: string,
    @Ip() ip?: string,
  ) {
    return this.auth.confirmEnrollment(dto.challengeToken, dto.code, meta(ua, ip));
  }

  /* ── the signed-in user's own account ── */

  @AllowWhenReadOnly()
  @UseGuards(JwtAuthGuard)
  @Patch('password')
  changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() current?: AccessTokenPayload,
  ) {
    return this.auth.changePassword(
      signedIn(current),
      dto.currentPassword,
      dto.newPassword,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() current?: AccessTokenPayload) {
    return this.auth.me(signedIn(current));
  }

  @UseGuards(JwtAuthGuard)
  @Get('mfa')
  mfaStatus(@CurrentUser() current?: AccessTokenPayload) {
    return this.auth.mfaStatus(signedIn(current));
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWhenReadOnly()
  @UseGuards(JwtAuthGuard)
  @Post('mfa/totp/setup')
  setupTotp(@CurrentUser() current?: AccessTokenPayload) {
    return this.auth.setupTotp(signedIn(current));
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWhenReadOnly()
  @UseGuards(JwtAuthGuard)
  @Post('mfa/totp/confirm')
  confirmTotp(@Body() dto: MfaCodeDto, @CurrentUser() current?: AccessTokenPayload) {
    return this.auth.confirmTotp(signedIn(current), dto.code);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWhenReadOnly()
  @UseGuards(JwtAuthGuard)
  @Post('mfa/recovery-codes')
  regenerateRecoveryCodes(
    @Body() dto: MfaCodeDto,
    @CurrentUser() current?: AccessTokenPayload,
  ) {
    return this.auth.regenerateRecoveryCodes(signedIn(current), dto.code);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWhenReadOnly()
  @UseGuards(JwtAuthGuard)
  @Post('mfa/disable')
  disableMfa(@Body() dto: DisableMfaDto, @CurrentUser() current?: AccessTokenPayload) {
    return this.auth.disableMfa(signedIn(current), dto.password, dto.code);
  }

  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  sessions(@CurrentUser() current?: AccessTokenPayload) {
    return this.auth.listSessions(signedIn(current));
  }

  @AllowWhenReadOnly()
  @UseGuards(JwtAuthGuard)
  @Post('sessions/revoke-others')
  revokeOtherSessions(@CurrentUser() current?: AccessTokenPayload) {
    return this.auth.revokeOtherSessions(signedIn(current));
  }

  @AllowWhenReadOnly()
  @UseGuards(JwtAuthGuard)
  @Post('sessions/:familyId/revoke')
  revokeSession(
    @Param('familyId', ParseUUIDPipe) familyId: string,
    @CurrentUser() current?: AccessTokenPayload,
  ) {
    return this.auth.revokeSession(signedIn(current), familyId);
  }
}
