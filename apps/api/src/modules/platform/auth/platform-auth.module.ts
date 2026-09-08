import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { platformJwtSecret } from './platform-secret';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformJwtGuard } from './platform-jwt.guard';
import { PlatformAuthController } from './platform-auth.controller';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: platformJwtSecret(config),
      }),
    }),
  ],
  controllers: [PlatformAuthController],
  providers: [PlatformAuthService, PlatformJwtGuard],
  exports: [PlatformAuthService, PlatformJwtGuard, JwtModule],
})
export class PlatformAuthModule {}
