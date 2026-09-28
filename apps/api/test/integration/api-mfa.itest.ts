import * as bcrypt from 'bcryptjs';
import { totpAt } from '@/core/mfa/totp';
import type { TestApi } from './api';
import { closePools, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Two-step sign-in (migration 0005), with MFA REQUIRED.
 *
 * Every other suite runs with MFA_ENFORCEMENT=optional (env.setup.js). This
 * one boots its own application with the production setting. The config
 * module reads the environment when it is first imported, so the API is
 * required inside jest.isolateModules after the variable is set — a fresh
 * module registry, a fresh ConfigModule, the same code.
 *
 * Rationed like the session suite: verify is throttled to ten a minute.
 */

let api: TestApi;
let call: typeof import('./api').call;
let s: Scenario;
const previousEnforcement = process.env.MFA_ENFORCEMENT;

beforeAll(async () => {
  process.env.MFA_ENFORCEMENT = 'required';
  let harness!: typeof import('./api');
  jest.isolateModules(() => {
    harness = require('./api');
  });
  call = harness.call;
  api = await harness.startApi();
  s = await createScenario();
});

afterAll(async () => {
  process.env.MFA_ENFORCEMENT = previousEnforcement;
  await destroyScenario(s);
  await api.close();
  await closePools();
});

type SignIn = {
  status: 'authenticated' | 'mfa_required' | 'mfa_enrollment_required';
  challengeToken?: string;
  accessToken?: string;
  refreshToken?: string;
  recoveryCodes?: string[];
  message?: string;
};

const post = <T = SignIn>(path: string, body: unknown, token?: string) =>
  call<T>(api, 'POST', path, { subdomain: s.a.subdomain, body, token });

const signIn = (email: string) =>
  post('/api/auth/login', { email, password: s.password });

/** Shared across the admin tests: enrollment feeds sign-in, sign-in feeds lockout. */
const admin = {
  secret: '',
  recoveryCodes: [] as string[],
  challenge: '',
  accessToken: '',
};

describe('an administrator without MFA', () => {
  it('gets no session from a password alone', async () => {
    const res = await signIn(s.a.adminEmail);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('mfa_enrollment_required');
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    admin.challenge = res.body.challengeToken!;
  });

  /**
   * The challenge is a JWT signed with the same key as access tokens, and it
   * proves a password. If a route accepted it, MFA would be decoration.
   */
  it('cannot use the challenge token as an access token', async () => {
    const res = await call<{ message: string }>(api, 'GET', '/api/auth/me', {
      subdomain: s.a.subdomain,
      token: admin.challenge,
    });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Wrong token type');
  });

  it('enrols, receives ten recovery codes, and only then gets a session', async () => {
    const started = await post<{ secret: string; otpauthUri: string }>(
      '/api/auth/mfa/enroll/start',
      { challengeToken: admin.challenge },
    );
    expect(started.status).toBe(201);
    expect(started.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(started.body.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    admin.secret = started.body.secret;

    const wrong = await post('/api/auth/mfa/enroll/confirm', {
      challengeToken: admin.challenge,
      code: '000000',
    });
    expect(wrong.status).toBe(400);

    const confirmed = await post('/api/auth/mfa/enroll/confirm', {
      challengeToken: admin.challenge,
      code: totpAt(admin.secret, Date.now()),
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.status).toBe('authenticated');
    expect(confirmed.body.accessToken).toEqual(expect.any(String));
    expect(confirmed.body.recoveryCodes).toHaveLength(10);
    admin.recoveryCodes = confirmed.body.recoveryCodes!;
    admin.accessToken = confirmed.body.accessToken!;
  });

  it('stores the secret only as ciphertext', async () => {
    const { rows } = await ownerQuery<{ secret_ciphertext: string; key_id: string }>(
      `SELECT secret_ciphertext, key_id FROM user_mfa_factors
        WHERE user_id = $1 AND disabled_at IS NULL`,
      [s.a.adminId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.secret_ciphertext).not.toContain(admin.secret);
    expect(rows[0]!.key_id).toEqual(expect.any(String));
  });
});

describe('an enrolled administrator', () => {
  it('is challenged, and signs in with a code from the authenticator', async () => {
    const res = await signIn(s.a.adminEmail);
    expect(res.body.status).toBe('mfa_required');
    admin.challenge = res.body.challengeToken!;

    // The next step's code: the enrollment code's step is already spent.
    const verified = await post('/api/auth/mfa/verify', {
      challengeToken: admin.challenge,
      code: totpAt(admin.secret, Date.now() + 30_000),
    });
    expect(verified.status).toBe(201);
    expect(verified.body.status).toBe('authenticated');
  });

  it('refuses the same code twice', async () => {
    const replay = await post('/api/auth/mfa/verify', {
      challengeToken: admin.challenge,
      code: totpAt(admin.secret, Date.now() + 30_000),
    });
    expect(replay.status).toBe(401);
  });

  it('accepts a recovery code exactly once', async () => {
    const code = admin.recoveryCodes[0]!;
    const first = await post('/api/auth/mfa/verify', {
      challengeToken: admin.challenge,
      recoveryCode: code.toLowerCase(),
    });
    expect(first.status).toBe(201);

    const again = await post('/api/auth/mfa/verify', {
      challengeToken: admin.challenge,
      recoveryCode: code,
    });
    expect(again.status).toBe(401);
  });

  it('locks the factor after five wrong codes', async () => {
    const messages: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await post('/api/auth/mfa/verify', {
        challengeToken: admin.challenge,
        code: '000000',
      });
      expect(res.status).toBe(401);
      messages.push(res.body.message ?? '');
    }
    expect(messages[4]).toMatch(/Too many/);

    const { rows } = await ownerQuery<{ locked: boolean }>(
      `SELECT locked_until > now() AS locked FROM user_mfa_factors
        WHERE user_id = $1 AND disabled_at IS NULL`,
      [s.a.adminId],
    );
    expect(rows[0]?.locked).toBe(true);

    // Unlock for anything that runs after this suite.
    await ownerQuery(
      `UPDATE user_mfa_factors SET locked_until = NULL, failed_attempts = 0 WHERE user_id = $1`,
      [s.a.adminId],
    );
  });

  it('cannot reset its own second factor through staff management', async () => {
    const res = await post<{ message: string }>(
      `/api/staff/${s.a.adminId}/mfa/reset`,
      {},
      admin.accessToken,
    );
    expect(res.status).toBe(400);
  });

  it('cannot turn MFA off, because administrators must have it', async () => {
    const res = await post<{ message: string }>(
      '/api/auth/mfa/disable',
      { password: s.password, code: totpAt(admin.secret, Date.now()) },
      admin.accessToken,
    );
    expect(res.status).toBe(403);
  });
});

describe('a receptionist', () => {
  let email: string;

  beforeAll(async () => {
    email = `desk-${Math.random().toString(36).slice(2, 8)}@${s.a.subdomain}.test`;
    await owner().query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
       VALUES ($1, $2, $3, 'Front Desk', 'receptionist', 'active')`,
      [s.a.id, email, await bcrypt.hash(s.password, 4)],
    );
  });

  it('signs in with a password alone while the clinic requires MFA only for administrators', async () => {
    const res = await signIn(email);
    expect(res.body.status).toBe('authenticated');
  });

  it('must enrol once the clinic requires MFA for everyone', async () => {
    await ownerQuery(
      `INSERT INTO clinic_settings (tenant_id, mfa_required_for_all) VALUES ($1, true)
       ON CONFLICT (tenant_id) DO UPDATE SET mfa_required_for_all = true`,
      [s.a.id],
    );
    const res = await signIn(email);
    expect(res.body.status).toBe('mfa_enrollment_required');
  });
});

describe('the platform console', () => {
  let adminId: string;
  const email = `console-${Math.random().toString(36).slice(2, 8)}@nodex.test`;

  beforeAll(async () => {
    const { rows } = await owner().query<{ id: string }>(
      `INSERT INTO platform_admins (email, password_hash, full_name)
       VALUES ($1, $2, 'Console Test') RETURNING id`,
      [email, await bcrypt.hash(s.password, 4)],
    );
    adminId = rows[0]!.id;
  });

  afterAll(async () => {
    await owner().query('DELETE FROM platform_admins WHERE id = $1', [adminId]);
  });

  it('requires every console account to enrol, and the challenge opens no console route', async () => {
    const res = await call<SignIn>(api, 'POST', '/api/platform/auth/login', {
      body: { email, password: s.password },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('mfa_enrollment_required');
    expect(res.body.accessToken).toBeUndefined();

    const tenants = await call(api, 'GET', '/api/platform/tenants', {
      token: res.body.challengeToken,
    });
    expect(tenants.status).toBe(401);
  });
});
