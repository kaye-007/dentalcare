import {
  Body,
  Controller,
  Get,
  Post,
  UnauthorizedException,
  UseGuards,
  Module,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { PlatformAuthService, PlatformTokenPayload } from './platform-auth.service';
import { PlatformLoginDto } from './dto/platform-login.dto';
import { PlatformJwtGuard, CurrentAdmin } from './platform-jwt.guard';

@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  // Superadmin credentials gate cross-tenant access — the highest-value
  // target in the system. Stricter than the clinic login.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('login')
  login(@Body() dto: PlatformLoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @UseGuards(PlatformJwtGuard)
  @Get('me')
  me(@CurrentAdmin() admin?: PlatformTokenPayload) {
    if (!admin) throw new UnauthorizedException();
    return this.auth.me(admin.sub);
  }
}

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [PlatformAuthController],
  providers: [PlatformAuthService, PlatformJwtGuard],
  exports: [PlatformAuthService, PlatformJwtGuard, JwtModule],
})
export class PlatformAuthModule {}
