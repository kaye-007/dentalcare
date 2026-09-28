import { createHmac, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { call, startApi, TestApi } from './api';
import { closePools, owner } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';
import { signInKeys, type SignInScope } from '@/core/auth-throttle/auth-throttle.service';

/**
 * Failed sign-ins are counted in the database (0025), so a lockout holds in
 * every process. The proof is a second API, with its own empty in-memory
 * throttle, refusing an account the first one locked: on Workers every
 * isolate is such a second API.
 *
 * Each request comes "from" a different client address (X-Forwarded-For,
 * which the proxy-aware req.ip reads), so the in-memory per-address throttle
 * never answers first and every 429 here is the database's.
 */

let api: TestApi;
let other: TestApi;
let s: Scenario;
let adminEmail: string;
let adminId: string;
const ADMIN_PASSWORD = 'console-password-long';

let n = 0;
const fromSomewhere = () => ({ 'X-Forwarded-For': `198.51.100.${(n++ % 250) + 1}` });

const clinic = (
  target: TestApi,
  email: string,
  password: string,
  subdomain = s.a.subdomain,
) =>
  call<{ code?: string; message?: string }>(target, 'POST', '/api/auth/login', {
    subdomain,
    body: { email, password },
    headers: fromSomewhere(),
  });
const console_ = (target: TestApi, email: string, password: string) =>
  call<{ code?: string; message?: string }>(target, 'POST', '/api/platform/auth/login', {
    body: { email, password },
    headers: fromSomewhere(),
  });

/** The row the API keeps for an account, found the way the API finds it. */
const accountKey = (scope: SignInScope, account: string) => {
  const secret = createHmac('sha256', process.env.JWT_SECRET ?? '')
    .update('dentalcare:auth-throttle:v1')
    .digest();
  return signInKeys(secret, scope, account, null).account;
};
const unlock = (key: string) =>
  owner().query(
    "UPDATE auth_throttle SET locked_until = now() - interval '1 second' WHERE key = $1",
    [key],
  );
const rowFor = async (key: string) =>
  (await owner().query('SELECT 1 FROM auth_throttle WHERE key = $1', [key])).rowCount;

/** Nine refusals, then the tenth attempt locks and says so. */
async function failTenTimes(
  attempt: () => Promise<{ status: number; body: { code?: string } }>,
) {
  const statuses: number[] = [];
  let last: { status: number; body: { code?: string } } | undefined;
  for (let i = 0; i < 10; i++) {
    last = await attempt();
    statuses.push(last.status);
  }
  return { statuses, last: last! };
}

beforeAll(async () => {
  api = await startApi();
  other = await startApi();
  s = await createScenario();
  adminEmail = `lockout-${randomBytes(4).toString('hex')}@nodex.test`;
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name, status)
     VALUES ($1, $2, 'Lockout Admin', 'active') RETURNING id`,
    [adminEmail, await bcrypt.hash(ADMIN_PASSWORD, 4)],
  );
  adminId = rows[0]!.id;
});

afterAll(async () => {
  await owner().query('DELETE FROM platform_admins WHERE id = $1', [adminId]);
  await destroyScenario(s);
  await Promise.all([api.close(), other.close()]);
  await closePools();
});

describe('a clinic account', () => {
  it('locks on the tenth failure, and the lock holds in another process', async () => {
    const { statuses, last } = await failTenTimes(() =>
      clinic(api, s.a.adminEmail, 'not-the-password'),
    );
    expect(statuses.slice(0, 9)).toEqual(Array(9).fill(401));
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('sign_in_locked');

    // The right password, on a second API with an empty in-memory throttle.
    const locked = await clinic(other, s.a.adminEmail, s.password);
    expect(locked.status).toBe(429);
    expect(locked.body.message).toMatch(/Try again in 1[45] minutes/);
  });

  it('opens again when the lock ends, and a sign-in forgets the failures', async () => {
    const key = accountKey('clinic', `${s.a.id}:${s.a.adminEmail}`);
    await unlock(key);
    const res = await clinic(other, s.a.adminEmail, s.password);
    expect(res.status).toBeLessThan(300);
    expect(await rowFor(key)).toBe(0);
  });

  it('locks an address nobody has exactly the same way, so a lock reveals no account', async () => {
    const nobody = `nobody-${randomBytes(4).toString('hex')}@klinika.test`;
    const { statuses, last } = await failTenTimes(() =>
      clinic(api, nobody, 'whatever-1'),
    );
    expect(statuses.slice(0, 9)).toEqual(Array(9).fill(401));
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('sign_in_locked');
  });

  it('is locked at its own clinic only', async () => {
    const email = `shared-${randomBytes(4).toString('hex')}@klinika.test`;
    await failTenTimes(() => clinic(api, email, 'wrong-password'));
    expect((await clinic(api, email, 'wrong-password', s.b.subdomain)).status).toBe(401);
  });
});

describe('a console account', () => {
  it('locks on the tenth failure, in every process', async () => {
    const { statuses, last } = await failTenTimes(() =>
      console_(api, adminEmail, 'not-the-password'),
    );
    expect(statuses.slice(0, 9)).toEqual(Array(9).fill(401));
    expect(last.status).toBe(429);

    expect((await console_(other, adminEmail, ADMIN_PASSWORD)).status).toBe(429);

    await unlock(accountKey('platform', adminEmail));
    expect((await console_(other, adminEmail, ADMIN_PASSWORD)).status).toBeLessThan(300);
  });
});

describe('one address trying many accounts', () => {
  it('is locked out of every sign-in after a hundred failures', async () => {
    // A documentation-range address of its own each run, sent the way
    // Cloudflare sends the client address.
    const address = `2001:db8::${randomBytes(2).toString('hex')}`;
    const attempt = () =>
      call<{ code?: string }>(api, 'POST', '/api/auth/login', {
        subdomain: s.a.subdomain,
        body: {
          email: `spray-${randomBytes(6).toString('hex')}@x.test`,
          password: 'Summer2026!',
        },
        headers: { ...fromSomewhere(), 'CF-Connecting-IP': address },
      });

    const statuses: number[] = [];
    for (let batch = 0; batch < 10; batch++) {
      const res = await Promise.all(Array.from({ length: 10 }, attempt));
      statuses.push(...res.map((r) => r.status));
    }
    expect(statuses.filter((x) => x === 401).length).toBeGreaterThanOrEqual(90);
    expect(statuses).toContain(429);

    // Any account now, from that address.
    const next = await attempt();
    expect(next.status).toBe(429);
    expect(next.body.code).toBe('sign_in_locked');

    // The same guess from somewhere else is only a wrong password.
    const elsewhere = await call(api, 'POST', '/api/auth/login', {
      subdomain: s.a.subdomain,
      body: { email: `spray-x@x.test`, password: 'Summer2026!' },
      headers: { ...fromSomewhere(), 'CF-Connecting-IP': '2001:db8::ffff:1' },
    });
    expect(elsewhere.status).toBe(401);
  });
});
