import {
  Body,
  Controller,
  Get,
  Headers,
  Ip,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ChallengeDto,
  ConfirmEnrollmentDto,
  RefreshDto,
  VerifyMfaDto,
} from '@/shared/dto/auth.dto';
import { PlatformAuthService, PlatformTokenPayload } from './platform-auth.service';
import { PlatformLoginDto } from './dto/platform-login.dto';
import { PlatformJwtGuard, CurrentAdmin } from './platform-jwt.guard';

const meta = (userAgent?: string, ip?: string) => ({ userAgent, ip });

@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  // Superadmin credentials gate cross-tenant access — the highest-value
  // target in the system. Stricter than the clinic login, and so is every
  // step that follows it.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('login')
  login(@Body() dto: PlatformLoginDto, @Headers('user-agent') ua?: string, @Ip() ip?: string) {
    return this.auth.login(dto.email, dto.password, meta(ua, ip));
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @Headers('user-agent') ua?: string, @Ip() ip?: string) {
    return this.auth.refresh(dto.refreshToken, meta(ua, ip));
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('mfa/verify')
  verifyMfa(@Body() dto: VerifyMfaDto, @Headers('user-agent') ua?: string, @Ip() ip?: string) {
    return this.auth.verifyMfa(
      dto.challengeToken,
      { code: dto.code, recoveryCode: dto.recoveryCode },
      meta(ua, ip),
    );
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('mfa/enroll/start')
  beginEnrollment(@Body() dto: ChallengeDto) {
    return this.auth.beginEnrollment(dto.challengeToken);
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('mfa/enroll/confirm')
  confirmEnrollment(
    @Body() dto: ConfirmEnrollmentDto,
    @Headers('user-agent') ua?: string,
    @Ip() ip?: string,
  ) {
    return this.auth.confirmEnrollment(dto.challengeToken, dto.code, meta(ua, ip));
  }

  @UseGuards(PlatformJwtGuard)
  @Get('me')
  me(@CurrentAdmin() admin?: PlatformTokenPayload) {
    if (!admin) throw new UnauthorizedException();
    return this.auth.me(admin.sub);
  }
}
