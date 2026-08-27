import { Global, Module } from '@nestjs/common';
import { GoogleStrategy } from './google.strategy';
import { ClinicGoogleGuard } from './clinic-google.guard';
import { GoogleCallbackGuard } from './google-callback.guard';
import { GoogleOAuthService, googleConfigured } from './google-oauth.service';
import { PlatformGoogleGuard } from './platform-google.guard';

/**
 * Global so both planes can use one strategy registration — passport keeps a
 * single named strategy per process, and registering "google" twice would
 * have the second quietly win.
 */
@Global()
@Module({
  providers: [
    GoogleOAuthService,
    ClinicGoogleGuard,
    PlatformGoogleGuard,
    GoogleCallbackGuard,
    // Only when configured; see googleConfigured() above.
    ...(googleConfigured() ? [GoogleStrategy] : []),
  ],
  exports: [
    GoogleOAuthService,
    ClinicGoogleGuard,
    PlatformGoogleGuard,
    GoogleCallbackGuard,
  ],
})
export class OAuthModule {}
