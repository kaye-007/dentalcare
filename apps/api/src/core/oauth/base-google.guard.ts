import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { createState, OAuthPlane, readState, safeReturnPath } from './oauth-state';
import { bindingCookie } from './oauth-binding';
import { GoogleOAuthService, RequestWithOAuth, SUBDOMAIN } from './google-oauth.service';

/**
 * Starts the redirect to Google, carrying a signed state.
 *
 * Built inside the guard because passport reads authenticate options before
 * the route handler runs, so a controller cannot hand the state over.
 *
 * The clinic comes from an explicit `?clinic=` rather than from tenant
 * context, because these routes sit OUTSIDE the tenant middleware: Google
 * requires one fixed redirect URI, so the callback arrives on the API host
 * with no clinic subdomain to read. Taking it as a parameter and signing it
 * into the state is what carries the decision across the round trip.
 *
 * Accepting any clinic name here leaks nothing — the callback still requires
 * a matching active user inside that clinic, which is the same bar password
 * login has always had against any subdomain.
 */
export abstract class BaseGoogleGuard extends AuthGuard('google') {
  protected abstract plane: OAuthPlane;

  constructor(protected readonly oauth: GoogleOAuthService) {
    super();
  }

  /**
   * Validate before delegating.
   *
   * `AuthGuard.canActivate` resolves the passport strategy by name, and an
   * unconfigured deployment has never registered one — so calling super first
   * turned "Google is not set up" into a 500 with a stack trace instead of a
   * 503 saying so. The same applies to a request that names no clinic.
   */
  canActivate(context: ExecutionContext) {
    this.oauth.assertEnabled();
    const req = context.switchToHttp().getRequest<Request>();

    let tenant: string | undefined;
    if (this.plane === 'clinic') {
      const raw =
        typeof req.query.clinic === 'string' ? req.query.clinic.toLowerCase() : '';
      if (!SUBDOMAIN.test(raw)) {
        throw new BadRequestException('Sign-in did not say which clinic.');
      }
      tenant = raw;
    }

    const next = safeReturnPath(
      typeof req.query.next === 'string' ? req.query.next : undefined,
    );
    // Stashed for getAuthenticateOptions, which passport calls next.
    const state = createState(
      { plane: this.plane, tenant, next },
      this.oauth.stateSecret,
    );
    (req as RequestWithOAuth).oauthOutboundState = state;
    // This browser, and only this one, may finish the sign-in (oauth-binding.ts).
    const { nonce } = readState(state, this.oauth.stateSecret);
    context
      .switchToHttp()
      .getResponse<Response>()
      .append('Set-Cookie', bindingCookie(nonce, this.oauth.bindingCookieOpts));
    return super.canActivate(context);
  }

  getAuthenticateOptions(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<RequestWithOAuth>();
    return {
      session: false,
      // Ask which account every time rather than silently reusing whichever
      // one the browser is signed into. A shared front-desk machine is the
      // normal case in a clinic, not the exception.
      prompt: 'select_account',
      state: req.oauthOutboundState,
    };
  }
}
