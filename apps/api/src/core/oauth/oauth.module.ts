import {
  BadRequestException,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { GoogleStrategy } from './google.strategy';
import {
  createState,
  InvalidOAuthState,
  OAuthPlane,
  OAuthState,
  readState,
  safeReturnPath,
} from './oauth-state';

/** Same shape the platform console enforces when a clinic is created. */
const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$/;

/**
 * Is Google sign-in configured on this deployment?
 *
 * Read from `process.env` at module-definition time rather than through
 * ConfigService, because the decision is whether to REGISTER the strategy at
 * all: `passport-google-oauth20` throws in its constructor without a client
 * id, so an unconfigured deployment would fail to boot rather than simply
 * offering password login. Clinics running without Google must still start.
 */
export function googleConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL,
  );
}

@Injectable()
export class GoogleOAuthService {
  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return googleConfigured();
  }

  /** Refuse clearly instead of bouncing the user to a broken Google page. */
  assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'Google sign-in is not configured on this server.',
      );
    }
  }

  /** The secret that signs the OAuth state. Shares JWT_SECRET's rotation. */
  get stateSecret(): string {
    return this.config.get<string>('JWT_SECRET')!;
  }

  /**
   * Where the browser lands after the callback. Clinics live on wildcard
   * subdomains, so the host is rebuilt from the clinic in the signed state
   * rather than trusted from the request.
   */
  appOrigin(plane: OAuthPlane, tenant?: string): string {
    const base = this.config.get<string>('APP_BASE_URL');
    if (!base) return '';
    if (plane === 'platform') {
      return this.config.get<string>('ADMIN_BASE_URL') ?? base;
    }
    // https://dentalcare.app -> https://avicena.dentalcare.app
    const url = new URL(base);
    if (tenant) url.hostname = `${tenant}.${url.hostname}`;
    return url.origin;
  }
}

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
abstract class BaseGoogleGuard extends AuthGuard('google') {
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
    (req as RequestWithOAuth).oauthOutboundState = createState(
      { plane: this.plane, tenant, next },
      this.oauth.stateSecret,
    );
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

/** What the guards attach to the request for the handler downstream. */
export interface RequestWithOAuth extends Request {
  oauthOutboundState?: string;
  oauthState?: OAuthState;
}

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

@Injectable()
export class PlatformGoogleGuard extends BaseGoogleGuard {
  protected plane: OAuthPlane = 'platform';
  constructor(oauth: GoogleOAuthService) {
    super(oauth);
  }
}

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
