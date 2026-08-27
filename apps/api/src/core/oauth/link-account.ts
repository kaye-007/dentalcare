import { GoogleIdentity } from './google.strategy';

/**
 * Who is allowed in, and on what terms.
 *
 * Kept as a pure function rather than inline in the controller because these
 * five branches are the entire security value of the feature, and they are
 * worth testing without a database, an HTTP round trip or Google.
 */

export interface LinkableAccount {
  id: string;
  status: 'active' | 'disabled';
  /** Null until the account's first Google sign-in. */
  google_sub: string | null;
}

export type LinkDecision =
  | { allow: true; userId: string; /** First sign-in: record the sub. */ link: boolean }
  | { allow: false; reason: string };

export function decideGoogleLink(
  account: LinkableAccount | null | undefined,
  identity: GoogleIdentity,
): LinkDecision {
  /**
   * Sign-in never creates an account.
   *
   * Auto-provisioning is the default in most OAuth tutorials and it is wrong
   * here: anyone with a Google account could mint themselves a login at any
   * clinic whose subdomain they can guess. A clinic user exists because an
   * administrator created them. Google only proves who is at the keyboard.
   *
   * The message stays vague on purpose — confirming which addresses have
   * accounts at which clinic is free reconnaissance.
   */
  if (!account) {
    return {
      allow: false,
      reason: 'No account here uses that Google address. Ask your clinic administrator to add you first.',
    };
  }

  if (account.status !== 'active') {
    return { allow: false, reason: 'That account has been disabled.' };
  }

  /**
   * The takeover case, and the reason migration 0020 stores `sub` at all.
   *
   * A clinic recycles `info@clinic.al` when the receptionist leaves. The new
   * holder signs in with Google, presents a verified email that matches, and
   * without this branch inherits the previous person's account and patients.
   * A verified email arriving under a different Google subject is refused, not
   * relinked — turning a silent takeover into a support call.
   */
  if (account.google_sub && account.google_sub !== identity.sub) {
    return {
      allow: false,
      reason:
        'That email is already linked to a different Google account. Sign in with a password, or ask your administrator to unlink it.',
    };
  }

  return { allow: true, userId: account.id, link: account.google_sub === null };
}
