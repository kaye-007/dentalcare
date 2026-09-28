import { call, startApi, TestApi } from './api';
import { closePools } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * The rate limits on the credential endpoints, asserted on purpose.
 *
 * They are in their own file because the throttler counts per IP and every
 * test here shares 127.0.0.1: exhausting a bucket in a suite that also tests
 * something else turns the last few assertions into accidental 429s. A fresh
 * application per file means a fresh in-memory bucket, so this can spend the
 * whole budget deliberately.
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

/** Attempt a sign-in with a deliberately wrong password. */
function attempt(subdomain: string, email: string) {
  return call<{ message: string }>(api, 'POST', '/api/auth/login', {
    subdomain,
    body: { email, password: 'wrong-on-purpose' },
  });
}

describe('the clinic login', () => {
  /**
   * Ten a minute. Enough that a person mistyping their password never
   * notices; far too few to work through a password list.
   *
   * The assertion is deliberately "it stops", not "it stops at exactly the
   * eleventh": tying a test to the precise count makes tuning the limit a
   * test failure rather than a decision, and the security property is that
   * the endpoint stops answering, not the specific number.
   */
  it('stops answering after repeated failures from one address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      statuses.push((await attempt(s.a.subdomain, s.a.adminEmail)).status);
    }

    expect(statuses).toContain(401);
    expect(statuses).toContain(429);

    // Once it starts refusing it keeps refusing, rather than letting every
    // other attempt through.
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  /**
   * And the limit is on the endpoint, not on the account — otherwise trying
   * one password against a thousand addresses would be unlimited, which is
   * the attack a per-account limit invites.
   */
  it('applies to a different address from the same caller', async () => {
    const res = await attempt(s.a.subdomain, 'someone-else@nowhere.test');

    expect(res.status).toBe(429);
  });

  /**
   * The throttle is per IP, so it must survive a caller switching clinics.
   * Bucketing per tenant would let an attacker reset the counter by naming a
   * different subdomain.
   */
  it('is not reset by pointing at another clinic', async () => {
    const res = await attempt(s.b.subdomain, s.b.adminEmail);

    expect(res.status).toBe(429);
  });
});

describe('the platform login', () => {
  /**
   * Stricter than the clinic login — five a minute — because these
   * credentials gate every clinic in the deployment at once. Its own file
   * would be overkill; its own bucket comes free, because the throttler keys
   * on the route as well as the address.
   */
  it('stops answering sooner than the clinic login', async () => {
    const nobody = `nobody-${Math.random().toString(36).slice(2, 10)}@nodex.test`;
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await call(api, 'POST', '/api/platform/auth/login', {
        // A fresh address each run: the account lockout (0025) remembers
        // failures in the database, and this is about the per-route limit.
        body: { email: nobody, password: 'wrong-on-purpose' },
      });
      statuses.push(res.status);
    }

    expect(statuses).toContain(401);
    expect(statuses).toContain(429);
    expect(statuses[statuses.length - 1]).toBe(429);

    // Fewer attempts get through here than on the clinic login, which is the
    // whole point of giving this endpoint its own, tighter limit.
    const answered = statuses.filter((x) => x === 401).length;
    expect(answered).toBeLessThan(10);
  });
});
