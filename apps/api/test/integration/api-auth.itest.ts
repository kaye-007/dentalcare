import { call, login, startApi, TestApi } from './api';
import { closePools, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * The auth surface, over HTTP, against a real database.
 *
 * The unit suite already covers the guards in isolation. What it cannot cover
 * is the composition: middleware resolving a clinic, then a guard checking a
 * token against the clinic that middleware resolved, then a service reading a
 * row the database scoped to that same clinic. Every one of those steps is
 * correct on its own and the interesting failures live between them.
 */

let api: TestApi;
let s: Scenario;
/**
 * One session, reused.
 *
 * Login is throttled to 10 per minute per IP, deliberately, and every test
 * here shares 127.0.0.1. Signing in once per assertion would spend that
 * budget on setup and start returning 429 to whichever test ran last — which
 * is how a suite ends up asserting the rate limiter by accident. The limit
 * itself is tested on purpose in api-throttle.itest.ts.
 */
let session: { accessToken: string; refreshToken?: string };

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  session = await login(api, s.a.subdomain, s.a.adminEmail, s.password);
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('signing in', () => {
  it('issues a token for the right password', () => {
    expect(session.accessToken).toEqual(expect.any(String));
    expect(session.refreshToken).toEqual(expect.any(String));
  });

  it('refuses the wrong password', async () => {
    const res = await call<{ message: string }>(api, 'POST', '/api/auth/login', {
      subdomain: s.a.subdomain,
      body: { email: s.a.adminEmail, password: 'not-the-password' },
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
  });

  /**
   * The same message for an unknown address as for a wrong password. A
   * different one would let anyone enumerate which staff a clinic employs.
   */
  it('refuses an unknown address with the same message', async () => {
    const res = await call<{ message: string }>(api, 'POST', '/api/auth/login', {
      subdomain: s.a.subdomain,
      body: { email: 'nobody@nowhere.test', password: s.password },
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
  });

  /**
   * Clinic A's administrator, with the right password, on clinic B's
   * subdomain. The account exists and the password is correct; it is simply
   * not an account of that clinic, and RLS is what makes the lookup miss.
   */
  it('refuses a valid account on another clinic', async () => {
    const res = await call<{ message: string }>(api, 'POST', '/api/auth/login', {
      subdomain: s.b.subdomain,
      body: { email: s.a.adminEmail, password: s.password },
    });

    expect(res.status).toBe(401);
  });

  it('404s a clinic that does not exist', async () => {
    const res = await call(api, 'POST', '/api/auth/login', {
      subdomain: 'no-such-clinic-anywhere',
      body: { email: s.a.adminEmail, password: s.password },
    });

    expect(res.status).toBe(404);
  });

  it('refuses a disabled account', async () => {
    await ownerQuery("UPDATE users SET status = 'disabled' WHERE id = $1", [s.b.adminId]);

    const res = await call<{ message: string }>(api, 'POST', '/api/auth/login', {
      subdomain: s.b.subdomain,
      body: { email: s.b.adminEmail, password: s.password },
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('This account is disabled');

    await ownerQuery("UPDATE users SET status = 'active' WHERE id = $1", [s.b.adminId]);
  });

  /**
   * Migration 0004 replaced the status set and both gates still tested the
   * old one, so the console's Archive button revoked nothing. Checked here
   * end to end rather than only at the middleware unit.
   */
  it.each(['suspended', 'archived'])(
    'refuses every request to a %s clinic',
    async (status) => {
      await ownerQuery('UPDATE tenants SET status = $1 WHERE id = $2', [status, s.b.id]);

      const res = await call<{ code: string }>(api, 'POST', '/api/auth/login', {
        subdomain: s.b.subdomain,
        body: { email: s.b.adminEmail, password: s.password },
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('tenant_suspended');

      await ownerQuery("UPDATE tenants SET status = 'active' WHERE id = $1", [s.b.id]);
    },
  );
});

describe('the token', () => {
  it('identifies the caller through /api/auth/me', async () => {
    const res = await call<{ email: string; role: string; tenantId: string }>(
      api,
      'GET',
      '/api/auth/me',
      { subdomain: s.a.subdomain, token: session.accessToken },
    );

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(s.a.adminEmail);
    expect(res.body.role).toBe('admin');
    expect(res.body.tenantId).toBe(s.a.id);
  });

  it('is required', async () => {
    const res = await call(api, 'GET', '/api/auth/me', {
      subdomain: s.a.subdomain,
    });

    expect(res.status).toBe(401);
  });

  it('is rejected when tampered with', async () => {
    const tampered = session.accessToken.slice(0, -3) + 'aaa';

    const res = await call(api, 'GET', '/api/auth/me', {
      subdomain: s.a.subdomain,
      token: tampered,
    });

    expect(res.status).toBe(401);
  });

  /**
   * A refresh token is not an access token. Without this the longer-lived
   * credential — seven days rather than fifteen minutes — would be usable
   * directly against every protected route.
   */
  it('refuses a refresh token used as an access token', async () => {
    expect(session.refreshToken).toEqual(expect.any(String));

    const res = await call<{ message: string }>(api, 'GET', '/api/auth/me', {
      subdomain: s.a.subdomain,
      token: session.refreshToken,
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Wrong token type');
  });

  it('exchanges a refresh token for a new access token', async () => {
    const res = await call<{ accessToken: string }>(api, 'POST', '/api/auth/refresh', {
      subdomain: s.a.subdomain,
      body: { refreshToken: session.refreshToken },
    });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });
});

describe('input validation', () => {
  it('rejects a malformed email before touching the database', async () => {
    const res = await call(api, 'POST', '/api/auth/login', {
      subdomain: s.a.subdomain,
      body: { email: 'not-an-email', password: s.password },
    });

    expect(res.status).toBe(400);
  });

  /**
   * forbidNonWhitelisted. A body carrying a field no DTO declares is refused
   * rather than quietly ignored, so a client cannot probe for one that is
   * accepted.
   */
  it('rejects a body with unexpected fields', async () => {
    const res = await call(api, 'POST', '/api/auth/login', {
      subdomain: s.a.subdomain,
      body: { email: s.a.adminEmail, password: s.password, role: 'admin' },
    });

    expect(res.status).toBe(400);
  });
});
