import { BadRequestException, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { InvalidOAuthState, readState } from './oauth-state';
import { boundToThisBrowser, clearedBindingCookie } from './oauth-binding';
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
    // Login CSRF: a callback URL sent to someone else carries a state their
    // browser never started. Checked before Google's code is exchanged.
    if (!boundToThisBrowser(req.headers.cookie, req.oauthState.nonce)) {
      throw new BadRequestException({
        code: 'oauth_not_this_browser',
        message:
          'This sign-in was not started in this browser. Start again from the sign-in page.',
      });
    }
    // Single use.
    context
      .switchToHttp()
      .getResponse<Response>()
      .append('Set-Cookie', clearedBindingCookie(this.oauth.bindingCookieOpts));
    return super.canActivate(context);
  }

  getAuthenticateOptions() {
    return { session: false };
  }
}
