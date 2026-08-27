import { decideGoogleLink, type LinkableAccount } from './link-account';
import type { GoogleIdentity } from './google.strategy';

const IDENTITY: GoogleIdentity = {
  sub: 'google-subject-1',
  email: 'rita@avicena.al',
  displayName: 'Rita Desk',
};

const account = (over: Partial<LinkableAccount> = {}): LinkableAccount => ({
  id: 'user-1',
  status: 'active',
  google_sub: null,
  ...over,
});

describe('decideGoogleLink', () => {
  it('links on the first sign-in and admits the user', () => {
    const d = decideGoogleLink(account(), IDENTITY);
    expect(d).toEqual({ allow: true, userId: 'user-1', link: true });
  });

  it('admits an already-linked account without relinking', () => {
    const d = decideGoogleLink(account({ google_sub: IDENTITY.sub }), IDENTITY);
    expect(d).toEqual({ allow: true, userId: 'user-1', link: false });
  });

  /**
   * No auto-provisioning. Without this branch, anyone with a Google account
   * could mint themselves a login at any clinic whose subdomain they can
   * guess — the subdomain being public.
   */
  it('never creates an account for an unknown address', () => {
    for (const missing of [null, undefined]) {
      const d = decideGoogleLink(missing, IDENTITY);
      expect(d.allow).toBe(false);
    }
  });

  it('does not confirm whether an address exists at this clinic', () => {
    const d = decideGoogleLink(null, IDENTITY);
    // "No account here uses that…" reads the same whether or not the address
    // is real. Enumerating staff addresses should not be free.
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).not.toContain(IDENTITY.email);
  });

  it('refuses a disabled account', () => {
    const d = decideGoogleLink(account({ status: 'disabled' }), IDENTITY);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/disabled/);
  });

  /**
   * The takeover case. A recycled clinic mailbox — `info@` after the
   * receptionist leaves — presents a genuinely verified email belonging to a
   * different person. Matching on email alone would hand over the patients.
   */
  it('refuses a verified email arriving under a different Google account', () => {
    const d = decideGoogleLink(account({ google_sub: 'the-original-subject' }), IDENTITY);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/different Google account/);
  });

  it('checks status before it checks the subject', () => {
    // A disabled account must not leak that it is also linked elsewhere.
    const d = decideGoogleLink(
      account({ status: 'disabled', google_sub: 'other' }),
      IDENTITY,
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/disabled/);
  });
});
