import { call, login, startApi, TestApi } from './api';
import { closePools, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * The lifecycle a real person actually performs, in order, against a migrated
 * database and the real HTTP surface:
 *
 *   an administrator exists -> sign in -> change the password -> sign out ->
 *   sign in with the new one -> the old one is refused
 *
 * Each step is covered elsewhere in isolation. This one exists because the
 * sequence is what fails: a password change that writes the hash but not
 * where login reads it, or a login that caches a user row past the change,
 * passes every unit test and locks someone out of their own clinic.
 *
 * It runs as one `it` on purpose. These steps are not independent — step four
 * is only meaningful if step three actually happened — and splitting them
 * into separate tests would let jest report "3 passed, 1 failed" for what is
 * really one broken sequence.
 */

let api: TestApi;
let s: Scenario;

const NEW_PASSWORD = 'a-completely-different-password';

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('the login acceptance path', () => {
  it('signs in, changes the password, and refuses the old one', async () => {
    /* ── 1. the administrator exists, with a hash and nothing else ────── */
    const { rows } = await ownerQuery<{ role: string; status: string }>(
      'SELECT role, status FROM users WHERE id = $1',
      [s.a.adminId],
    );
    expect(rows[0]).toEqual({ role: 'admin', status: 'active' });

    /* ── 2. sign in ──────────────────────────────────────────────────── */
    const first = await login(api, s.a.subdomain, s.a.adminEmail, s.password);
    expect(first.accessToken).toEqual(expect.any(String));

    /* ── 3. change the password ──────────────────────────────────────── */
    const changed = await call(api, 'PATCH', '/api/auth/password', {
      subdomain: s.a.subdomain,
      token: first.accessToken,
      body: { currentPassword: s.password, newPassword: NEW_PASSWORD },
    });
    expect(changed.status).toBe(200);

    /* ── 4. sign out ─────────────────────────────────────────────────── */
    // There is no logout endpoint: the SPA discards the token. Modelled
    // honestly by dropping the reference rather than by calling something
    // that does not exist.
    const discarded = first.accessToken;

    /* ── 5. the new password works ───────────────────────────────────── */
    const second = await login(api, s.a.subdomain, s.a.adminEmail, NEW_PASSWORD);
    expect(second.accessToken).toEqual(expect.any(String));

    const me = await call<{ email: string }>(api, 'GET', '/api/auth/me', {
      subdomain: s.a.subdomain,
      token: second.accessToken,
    });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(s.a.adminEmail);

    /* ── 6. the old password does not ────────────────────────────────── */
    const refused = await call<{ message: string }>(api, 'POST', '/api/auth/login', {
      subdomain: s.a.subdomain,
      body: { email: s.a.adminEmail, password: s.password },
    });
    expect(refused.status).toBe(401);
    expect(refused.body.message).toBe('Invalid email or password');

    /**
     * And the part that is currently a known limitation rather than a
     * guarantee: the token minted before the change still works, because
     * nothing revokes it. It expires on its own in JWT_ACCESS_TTL.
     *
     * Written down as an assertion rather than left unsaid, so that the day
     * someone adds revocation this test fails and tells them the behaviour
     * they just changed was known and deliberate — not an accident. It is
     * listed under Outstanding in docs/SECURITY_AUDIT.md.
     */
    const stale = await call(api, 'GET', '/api/auth/me', {
      subdomain: s.a.subdomain,
      token: discarded,
    });
    expect(stale.status).toBe(200);
  });

  it('refuses a password change that gets the current password wrong', async () => {
    const session = await login(api, s.b.subdomain, s.b.adminEmail, s.password);

    const res = await call<{ message: string }>(api, 'PATCH', '/api/auth/password', {
      subdomain: s.b.subdomain,
      token: session.accessToken,
      body: { currentPassword: 'not-it', newPassword: NEW_PASSWORD },
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Current password is incorrect');

    // And the old one still works, so a failed attempt changed nothing.
    await expect(
      login(api, s.b.subdomain, s.b.adminEmail, s.password),
    ).resolves.toBeDefined();
  });

  /**
   * Re-setting the same password is refused. Otherwise "change your password"
   * can be satisfied without changing anything, which is the one outcome the
   * requirement exists to prevent.
   */
  it('refuses a new password identical to the current one', async () => {
    const session = await login(api, s.b.subdomain, s.b.adminEmail, s.password);

    const res = await call<{ message: string }>(api, 'PATCH', '/api/auth/password', {
      subdomain: s.b.subdomain,
      token: session.accessToken,
      body: { currentPassword: s.password, newPassword: s.password },
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('New password must be different');
  });

  it('refuses a new password shorter than the minimum', async () => {
    const session = await login(api, s.b.subdomain, s.b.adminEmail, s.password);

    const res = await call(api, 'PATCH', '/api/auth/password', {
      subdomain: s.b.subdomain,
      token: session.accessToken,
      body: { currentPassword: s.password, newPassword: 'short' },
    });

    expect(res.status).toBe(400);
  });
});
