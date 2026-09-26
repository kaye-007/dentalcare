import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { closePools, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Server-side sessions (migration 0005), over HTTP.
 *
 * What these prove is the difference between a refresh token that is a row
 * and one that was a seven-day JWT: it rotates, a replay ends the whole
 * session, logout means something, and a password change or a disabled
 * account takes effect at the next refresh instead of a week later.
 *
 * Login is throttled to ten a minute per IP and this suite shares 127.0.0.1,
 * so sign-ins are rationed — seven, with tests chaining where they can.
 */

let api: TestApi;
let s: Scenario;

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

type Tokens = { accessToken: string; refreshToken: string };

const refresh = (token: string, subdomain = s.a.subdomain) =>
  call<Tokens & { message?: string }>(api, 'POST', '/api/auth/refresh', {
    subdomain,
    body: { refreshToken: token },
  });

const signIn = async () =>
  (await login(api, s.a.subdomain, s.a.adminEmail, s.password)) as Tokens;

describe('a refresh token', () => {
  it('is opaque, rotates on use, tolerates the two-tab race, and ends the session on replay', async () => {
    const first = await signIn();
    expect(first.refreshToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

    // Rotation: a new refresh token each time, and the access token works.
    const second = await refresh(first.refreshToken);
    expect(second.status).toBe(201);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);
    const me = await call(api, 'GET', '/api/auth/me', {
      subdomain: s.a.subdomain,
      token: second.body.accessToken,
    });
    expect(me.status).toBe(200);

    // Two tabs refreshing with the same token in the same moment: both win.
    const tabA = await refresh(second.body.refreshToken);
    const tabB = await refresh(second.body.refreshToken);
    expect(tabA.status).toBe(201);
    expect(tabB.status).toBe(201);

    // The same token presented after the grace period is a stolen token being
    // replayed. It is refused, and so is everything descended from it.
    const sessionId = second.body.refreshToken.split('.')[0];
    await ownerQuery(
      `UPDATE user_sessions SET rotated_at = now() - interval '5 minutes' WHERE id = $1`,
      [sessionId],
    );
    const replay = await refresh(second.body.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.message).toMatch(/used twice/);

    expect((await refresh(tabA.body.refreshToken)).status).toBe(401);
    expect((await refresh(tabB.body.refreshToken)).status).toBe(401);
  });

  it('is refused on another clinic’s subdomain', async () => {
    const tokens = await signIn();
    const res = await refresh(tokens.refreshToken, s.b.subdomain);
    expect(res.status).toBe(401);
    // And it still works where it belongs: the attempt revoked nothing.
    expect((await refresh(tokens.refreshToken)).status).toBe(201);
  });
});

describe('logout', () => {
  it('ends the session for every token in it', async () => {
    const tokens = await signIn();
    const out = await call(api, 'POST', '/api/auth/logout', {
      subdomain: s.a.subdomain,
      body: { refreshToken: tokens.refreshToken },
    });
    expect(out.status).toBe(201);
    expect((await refresh(tokens.refreshToken)).status).toBe(401);
  });

  it('says nothing about a token it does not recognise', async () => {
    const out = await call(api, 'POST', '/api/auth/logout', {
      subdomain: s.a.subdomain,
      body: { refreshToken: 'not-a-session' },
    });
    expect(out.status).toBe(201);
  });
});

describe('changing a password', () => {
  it('ends every other session and keeps the one it was changed from', async () => {
    const here = await signIn();
    const elsewhere = await signIn();

    const changed = await call(api, 'PATCH', '/api/auth/password', {
      subdomain: s.a.subdomain,
      token: here.accessToken,
      body: { currentPassword: s.password, newPassword: 'a-different-password-entirely' },
    });
    expect(changed.status).toBe(200);

    expect((await refresh(elsewhere.refreshToken)).status).toBe(401);
    expect((await refresh(here.refreshToken)).status).toBe(201);

    // Put the fixture password back for the suites after this one.
    await ownerQuery('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await bcrypt.hash(s.password, 4),
      s.a.adminId,
    ]);
  });
});

describe('a disabled account', () => {
  it('is signed out at its next refresh, not seven days later', async () => {
    const email = `desk-${Math.random().toString(36).slice(2, 8)}@${s.a.subdomain}.test`;
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
       VALUES ($1, $2, $3, 'Front Desk', 'receptionist', 'active') RETURNING id`,
      [s.a.id, email, await bcrypt.hash(s.password, 4)],
    );
    const tokens = (await login(api, s.a.subdomain, email, s.password)) as Tokens;

    await ownerQuery(`UPDATE users SET status = 'disabled' WHERE id = $1`, [rows[0]!.id]);

    const res = await refresh(tokens.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Account no longer active');
  });
});

describe('signed-in devices', () => {
  it('lists them, marks this one, and can end the others', async () => {
    const here = await signIn();
    const elsewhere = await signIn();

    const list = await call<{ current: boolean }[]>(api, 'GET', '/api/auth/sessions', {
      subdomain: s.a.subdomain,
      token: here.accessToken,
    });
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    expect(list.body.filter((x) => x.current)).toHaveLength(1);

    const ended = await call<{ revoked: number }>(
      api,
      'POST',
      '/api/auth/sessions/revoke-others',
      { subdomain: s.a.subdomain, token: here.accessToken },
    );
    expect(ended.status).toBe(201);
    expect(ended.body.revoked).toBeGreaterThanOrEqual(1);

    expect((await refresh(elsewhere.refreshToken)).status).toBe(401);
    expect((await refresh(here.refreshToken)).status).toBe(201);
  });
});
