import { BadRequestException, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InvalidOAuthState, readState } from './oauth-state';
import { GoogleOAuthService, RequestWithOAuth } from './google-oauth.service';

/**
 * The callback guard.
 *
 * Verifies the signed state BEFORE letting passport exchange the code. That
 * ordering is the point: an unverified state means the request may not have
 * started here, and there is no reason to trade a code with Google — or to
 * touch an account — on the strength of it.
 */
@Injectable()
export class GoogleCallbackGuard extends AuthGuard('google') {
  constructor(private readonly oauth: GoogleOAuthService) {
    super();
  }

  canActivate(context: ExecutionContext) {
    this.oauth.assertEnabled();
    const req = context.switchToHttp().getRequest<RequestWithOAuth>();
    try {
      req.oauthState = readState(
        typeof req.query.state === 'string' ? req.query.state : undefined,
        this.oauth.stateSecret,
      );
    } catch (err) {
      throw new BadRequestException({
        code: 'oauth_state_invalid',
        message: err instanceof InvalidOAuthState ? err.message : 'Sign-in failed.',
      });
    }
    return super.canActivate(context);
  }

  getAuthenticateOptions() {
    return { session: false };
  }
}
