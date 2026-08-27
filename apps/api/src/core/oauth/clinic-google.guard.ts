import { Injectable } from '@nestjs/common';
import { OAuthPlane } from './oauth-state';
import { BaseGoogleGuard } from './base-google.guard';
import { GoogleOAuthService } from './google-oauth.service';

/**
 * The explicit constructors are load-bearing, not ceremony.
 *
 * TypeScript only emits `design:paramtypes` for a class that declares its own
 * constructor. Without one, Nest cannot see the base class's dependency and
 * injects nothing — `this.oauth` is undefined, and the first call on it turns
 * a deliberate 503 into a 500 with a stack trace.
 */
@Injectable()
export class ClinicGoogleGuard extends BaseGoogleGuard {
  protected plane: OAuthPlane = 'clinic';
  constructor(oauth: GoogleOAuthService) {
    super(oauth);
  }
}
