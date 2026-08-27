import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { UsersModule } from '@/modules/clinic/users';
import { PlatformAuthModule } from '@/modules/platform/auth';
import { GoogleCallbackGuard } from './google-callback.guard';
import { OAuthController } from './oauth.controller';

@Module({
  imports: [AuthModule, UsersModule, PlatformAuthModule],
  controllers: [OAuthController],
  providers: [GoogleCallbackGuard],
})
export class OAuthRoutesModule {}
