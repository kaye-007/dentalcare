import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile } from 'passport-google-oauth20';

/** What the rest of the application is allowed to know about a Google user. */
export interface GoogleIdentity {
  /** Google's immutable subject id. The real join key — see migration 0020. */
  sub: string;
  email: string;
  displayName: string | null;
}

/**
 * Google OAuth2, stateless.
 *
 * Two deliberate departures from the copy-and-paste version of this file:
 *
 *  - `state` is NOT delegated to passport (`state: true` would make it store a
 *    value in an express session). This API has no sessions and should not
 *    grow one for a redirect. The state is minted and verified by
 *    `oauth-state.ts` instead, which also has to carry the clinic across the
 *    round trip.
 *
 *  - `email_verified` is enforced here rather than downstream. An unverified
 *    address is a claim, not an identity; accepting one would let anybody who
 *    can type a colleague's email into a Google signup walk into their clinic.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    super({
      clientID: config.get<string>('GOOGLE_CLIENT_ID')!,
      clientSecret: config.get<string>('GOOGLE_CLIENT_SECRET')!,
      callbackURL: config.get<string>('GOOGLE_CALLBACK_URL')!,
      scope: ['email', 'profile'],
    });
  }

  /**
   * Passport calls this after a successful code exchange. Its return value
   * becomes `req.user` — deliberately the narrow `GoogleIdentity` and not
   * Google's whole profile, so no controller can start depending on a field
   * we have not reasoned about.
   */
  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): GoogleIdentity {
    const primary = profile.emails?.[0];
    const email = primary?.value?.trim().toLowerCase();

    if (!email) {
      throw new UnauthorizedException(
        'Google did not return an email address for that account.',
      );
    }

    // The typings model this as `boolean | undefined` on some versions and a
    // string on others; treat anything that is not an explicit yes as a no.
    const verified = (primary as { verified?: boolean | string }).verified;
    if (verified !== true && verified !== 'true') {
      throw new UnauthorizedException(
        'That Google account has not verified its email address.',
      );
    }

    return {
      sub: profile.id,
      email,
      displayName: profile.displayName?.trim() || null,
    };
  }
}
