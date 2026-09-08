import { call, login, startApi, TestApi } from './api';
import { closePools, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * What an expired trial does, and — more importantly — what it does not.
 *
 * The product decision is that a clinic past its trial keeps every read and
 * loses every write. Their own data is the argument for paying, so locking
 * them out of looking at it is the one behaviour guaranteed to lose the sale.
 *
 * Two things are easy to get wrong here and both are tested:
 *   - an expired trial must not be treated as a suspension (403 at the door)
 *   - signing in and changing a password must keep working, because
 *     withholding writes is a payment lever and withholding someone's ability
 *     to rotate their own credentials is a security regression
 */

let api: TestApi;
let s: Scenario;
let token: string;

/** Puts clinic A's trial in the past. */
async function expireTrial(): Promise<void> {
  await ownerQuery(
    "UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = $1",
    [s.a.id],
  );
}

async function clearTrial(): Promise<void> {
  await ownerQuery('UPDATE tenants SET trial_ends_at = NULL WHERE id = $1', [s.a.id]);
}

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  token = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
});

afterAll(async () => {
  await clearTrial();
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('while the trial is running', () => {
  it('writes are allowed', async () => {
    await ownerQuery(
      "UPDATE tenants SET trial_ends_at = now() + interval '7 days' WHERE id = $1",
      [s.a.id],
    );

    const res = await call(api, 'POST', '/api/patients', {
      subdomain: s.a.subdomain,
      token,
      body: { firstName: 'During', lastName: 'Trial' },
    });

    expect(res.status).toBe(201);
    await clearTrial();
  });
});

describe('once the trial has expired', () => {
  beforeAll(expireTrial);
  afterAll(clearTrial);

  it('reads still work', async () => {
    const res = await call(api, 'GET', '/api/patients', {
      subdomain: s.a.subdomain,
      token,
    });

    expect(res.status).toBe(200);
  });

  it('/api/auth/me reports the expiry so the UI can say so', async () => {
    const res = await call<{ trial: { readOnly: boolean; endsAt: string | null } }>(
      api,
      'GET',
      '/api/auth/me',
      { subdomain: s.a.subdomain, token },
    );

    expect(res.status).toBe(200);
    expect(res.body.trial.readOnly).toBe(true);
    expect(res.body.trial.endsAt).toEqual(expect.any(String));
  });

  /**
   * 402, not 403. The clinic is not forbidden, it has not paid — and that
   * distinction is what lets the SPA show "your trial ended" instead of
   * "access denied", which are very different things to say to a prospect.
   */
  it('writes are refused with 402 and a reason', async () => {
    const res = await call<{ code: string; trialEndsAt: string | null }>(
      api,
      'POST',
      '/api/patients',
      {
        subdomain: s.a.subdomain,
        token,
        body: { firstName: 'After', lastName: 'Trial' },
      },
    );

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('trial_expired');
    expect(res.body.trialEndsAt).toEqual(expect.any(String));
  });

  it.each([
    ['PATCH', `/api/patients/PLACEHOLDER`],
    ['POST', '/api/treatments'],
  ])('%s %s is refused too', async (method, path) => {
    const res = await call(api, method, path.replace('PLACEHOLDER', s.a.patientId), {
      subdomain: s.a.subdomain,
      token,
      body: { firstName: 'Nope' },
    });

    expect(res.status).toBe(402);
  });

  /** Signing in is explicitly allowed after expiry — see AllowWhenReadOnly. */
  it('signing in still works', async () => {
    const session = await login(api, s.a.subdomain, s.a.adminEmail, s.password);

    expect(session.accessToken).toEqual(expect.any(String));
  });

  /**
   * The one that matters most. A trial lever must never take away someone's
   * ability to rotate a credential they believe is compromised.
   */
  it('changing a password still works', async () => {
    const session = await login(api, s.a.subdomain, s.a.adminEmail, s.password);

    const res = await call(api, 'PATCH', '/api/auth/password', {
      subdomain: s.a.subdomain,
      token: session.accessToken,
      body: { currentPassword: s.password, newPassword: 'rotated-during-expiry' },
    });

    expect(res.status).toBe(200);

    // Put it back, so the shared fixture password stays true for later tests.
    const after = await login(
      api,
      s.a.subdomain,
      s.a.adminEmail,
      'rotated-during-expiry',
    );
    const restored = await call(api, 'PATCH', '/api/auth/password', {
      subdomain: s.a.subdomain,
      token: after.accessToken,
      body: { currentPassword: 'rotated-during-expiry', newPassword: s.password },
    });
    expect(restored.status).toBe(200);
  });

  /**
   * An expired trial is not a suspension. If the middleware collapsed the two
   * the clinic would 403 at the door and never see the data that sells the
   * subscription.
   */
  it('is not treated as a suspension', async () => {
    const res = await call(api, 'GET', '/api/patients', {
      subdomain: s.a.subdomain,
      token,
    });

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });
});

describe('a paying clinic', () => {
  it('is unrestricted once trial_ends_at is cleared', async () => {
    await clearTrial();

    const res = await call(api, 'POST', '/api/patients', {
      subdomain: s.a.subdomain,
      token,
      body: { firstName: 'Paying', lastName: 'Clinic' },
    });

    expect(res.status).toBe(201);
  });
});
