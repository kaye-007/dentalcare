import { Injectable } from '@nestjs/common';
import { OAuthPlane } from './oauth-state';
import { BaseGoogleGuard } from './base-google.guard';
import { GoogleOAuthService } from './google-oauth.service';

@Injectable()
export class PlatformGoogleGuard extends BaseGoogleGuard {
  protected plane: OAuthPlane = 'platform';
  constructor(oauth: GoogleOAuthService) {
    super(oauth);
  }
}
