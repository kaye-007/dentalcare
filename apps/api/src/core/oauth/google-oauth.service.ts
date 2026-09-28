import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { OAuthPlane, OAuthState } from './oauth-state';
import { bindingDomain } from './oauth-binding';

/** Same shape the platform console enforces when a clinic is created. */
export const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$/;

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
  /**
   * How the browser-binding cookie is written (oauth-binding.ts): scoped to
   * the parent domain of the callback host, Secure in production.
   */
  get bindingCookieOpts(): { domain?: string; secure: boolean } {
    const callback = process.env.GOOGLE_CALLBACK_URL;
    return {
      domain: callback ? bindingDomain(new URL(callback).hostname) : undefined,
      secure: this.config.get<string>('NODE_ENV') === 'production',
    };
  }

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

/** What the guards attach to the request for the handler downstream. */
export interface RequestWithOAuth extends Request {
  oauthOutboundState?: string;
  oauthState?: OAuthState;
}
