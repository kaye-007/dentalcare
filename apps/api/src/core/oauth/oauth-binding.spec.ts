import { BadRequestException, ExecutionContext } from '@nestjs/common';
import {
  BINDING_COOKIE,
  bindingCookie,
  bindingDomain,
  boundToThisBrowser,
  clearedBindingCookie,
} from './oauth-binding';
import { createState, readState } from './oauth-state';
import { GoogleCallbackGuard } from './google-callback.guard';
import { ClinicGoogleGuard } from './clinic-google.guard';
import type { GoogleOAuthService } from './google-oauth.service';

/**
 * Login CSRF: a Google sign-in may only be finished by the browser that
 * started it. See oauth-binding.ts.
 */

describe('bindingDomain', () => {
  it.each([
    ['api.dentalcare.com', 'dentalcare.com'],
    ['api.staging.dentalcare.com', 'staging.dentalcare.com'],
    ['dentalcare.com', 'dentalcare.com'],
    ['API.DentalCare.com', 'dentalcare.com'],
  ])('scopes %s to %s, which the clinic and console hosts share', (host, domain) => {
    expect(bindingDomain(host)).toBe(domain);
  });

  it.each(['localhost', '127.0.0.1', '::1'])('is host-only for %s', (host) => {
    expect(bindingDomain(host)).toBeUndefined();
  });
});

describe('the cookie', () => {
  it('is HttpOnly, Lax, lives as long as a state, and is scoped to the sign-in path', () => {
    expect(bindingCookie('n0nce', { domain: 'dentalcare.com', secure: true })).toBe(
      `${BINDING_COOKIE}=n0nce; Max-Age=600; Path=/api/auth/google; HttpOnly; SameSite=Lax; Secure; Domain=dentalcare.com`,
    );
  });

  it('is not Secure on plain-HTTP development, and host-only without a domain', () => {
    expect(bindingCookie('n0nce', { secure: false })).toBe(
      `${BINDING_COOKIE}=n0nce; Max-Age=600; Path=/api/auth/google; HttpOnly; SameSite=Lax`,
    );
  });

  it('is removed with the same path and domain it was set with', () => {
    expect(clearedBindingCookie({ domain: 'dentalcare.com', secure: true })).toBe(
      `${BINDING_COOKIE}=; Max-Age=0; Path=/api/auth/google; HttpOnly; SameSite=Lax; Secure; Domain=dentalcare.com`,
    );
  });
});

describe('boundToThisBrowser', () => {
  it('accepts the nonce among other cookies', () => {
    expect(
      boundToThisBrowser(`theme=dark; ${BINDING_COOKIE}=abc123; x=1`, 'abc123'),
    ).toBe(true);
  });

  it.each([
    ['no cookies at all', undefined],
    ['other cookies only', 'theme=dark'],
    ['another sign-in', `${BINDING_COOKIE}=zzz999`],
    ['an emptied cookie', `${BINDING_COOKIE}=`],
    ['a prefix of the nonce', `${BINDING_COOKIE}=abc12`],
  ])('refuses %s', (_why, header) => {
    expect(boundToThisBrowser(header, 'abc123')).toBe(false);
  });
});

/* ── the guards ─────────────────────────────────────────────────────────── */

const SECRET = 'state-secret-for-the-guard-tests';
const oauth = {
  assertEnabled: () => undefined,
  stateSecret: SECRET,
  bindingCookieOpts: { domain: 'dentalcare.com', secure: true },
} as unknown as GoogleOAuthService;

function context(req: Record<string, unknown>) {
  const append = jest.fn();
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ append }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, append };
}

describe('starting a sign-in', () => {
  it('leaves the state’s nonce in this browser', async () => {
    const req: Record<string, unknown> = { query: { clinic: 'demo' }, headers: {} };
    const { ctx, append } = context(req);
    // Passport is not set up in a unit test; everything before it has run.
    await Promise.resolve()
      .then(() => new ClinicGoogleGuard(oauth).canActivate(ctx))
      .catch(() => undefined);
    const { nonce } = readState(req.oauthOutboundState as string, SECRET);
    expect(append).toHaveBeenCalledWith(
      'Set-Cookie',
      bindingCookie(nonce, { domain: 'dentalcare.com', secure: true }),
    );
  });
});

describe('the callback', () => {
  const state = () => createState({ plane: 'clinic', tenant: 'demo' }, SECRET);

  it('refuses a state this browser did not start, before any exchange with Google', () => {
    const { ctx, append } = context({ query: { state: state() }, headers: {} });
    let thrown: unknown;
    try {
      void new GoogleCallbackGuard(oauth).canActivate(ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      code: 'oauth_not_this_browser',
    });
    expect(append).not.toHaveBeenCalled();
  });

  it('lets the browser that started it through, and uses the cookie up', async () => {
    const raw = state();
    const { nonce } = readState(raw, SECRET);
    const { ctx, append } = context({
      query: { state: raw },
      headers: { cookie: `${BINDING_COOKIE}=${nonce}` },
    });
    let thrown: unknown;
    await Promise.resolve()
      .then(() => new GoogleCallbackGuard(oauth).canActivate(ctx))
      .catch((e: unknown) => (thrown = e));
    // Whatever passport does next, it is not the binding refusing.
    expect((thrown as { response?: { code?: string } })?.response?.code).not.toBe(
      'oauth_not_this_browser',
    );
    expect(append).toHaveBeenCalledWith(
      'Set-Cookie',
      clearedBindingCookie({ domain: 'dentalcare.com', secure: true }),
    );
  });
});
