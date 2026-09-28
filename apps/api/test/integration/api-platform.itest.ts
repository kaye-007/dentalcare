import * as bcrypt from 'bcryptjs';
import { call, login, startApi, TestApi } from './api';
import { closePools, owner, ownerQuery } from './db';
import { createScenario, destroyScenario, destroyTenants, Scenario } from './fixtures';

/**
 * The platform plane: the half of the system that is SUPPOSED to see across
 * clinics, and the boundary that keeps it separate from the half that is not.
 *
 * Isolation that also blocked the console would be a different bug, not a
 * stronger guarantee — nobody could list clinics, suspend one, or extend a
 * trial. So this checks that the console works, and that the two planes
 * cannot be crossed with each other's credentials in either direction.
 */

let api: TestApi;
let s: Scenario;
let adminEmail: string;
let adminId: string;
let platformToken: string;

const PLATFORM_PASSWORD = 'platform-integration-password';

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();

  adminEmail = `platform-${Math.random().toString(36).slice(2, 8)}@nodex.test`;
  const { rows } = await owner().query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name, status)
     VALUES ($1, $2, 'Integration Admin', 'active') RETURNING id`,
    [adminEmail, await bcrypt.hash(PLATFORM_PASSWORD, 4)],
  );
  adminId = rows[0].id;

  const res = await call<{ accessToken: string }>(
    api,
    'POST',
    '/api/platform/auth/login',
    { body: { email: adminEmail, password: PLATFORM_PASSWORD } },
  );
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`platform login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  platformToken = res.body.accessToken;
});

afterAll(async () => {
  await ownerQuery('DELETE FROM platform_admins WHERE id = $1', [adminId]);
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('the console operates across clinics', () => {
  /**
   * The counterpart to every isolation test. The platform connection is the
   * privileged one by design, and this is the assertion that says so out loud
   * — so that "tighten isolation" never silently means "break the console".
   */
  it('lists both clinics in one response', async () => {
    const res = await call<unknown>(api, 'GET', '/api/platform/tenants', {
      token: platformToken,
    });

    expect(res.status).toBe(200);
    const subdomains = collect(res.body, 'subdomain');
    expect(subdomains).toContain(s.a.subdomain);
    expect(subdomains).toContain(s.b.subdomain);
  });

  it('reads either clinic by id', async () => {
    for (const tenant of [s.a, s.b]) {
      const res = await call<{ subdomain?: string; tenant?: { subdomain: string } }>(
        api,
        'GET',
        `/api/platform/tenants/${tenant.id}`,
        { token: platformToken },
      );

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain(tenant.subdomain);
    }
  });

  /**
   * Commercial state is the platform's to change — and, since 0021, ONLY the
   * platform's. The clinic plane cannot write these columns at all; this is
   * the other half of that arrangement working.
   */
  it('suspends a clinic, which the clinic itself cannot do', async () => {
    const res = await call(api, 'PATCH', `/api/platform/tenants/${s.b.id}/status`, {
      token: platformToken,
      body: { status: 'suspended' },
    });

    expect(res.status).toBe(200);

    const { rows } = await ownerQuery<{ status: string }>(
      'SELECT status FROM tenants WHERE id = $1',
      [s.b.id],
    );
    expect(rows[0].status).toBe('suspended');

    // And the suspension is immediately effective at the clinic's own door.
    const denied = await call<{ code: string }>(api, 'POST', '/api/auth/login', {
      subdomain: s.b.subdomain,
      body: { email: s.b.adminEmail, password: s.password },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('tenant_suspended');

    await ownerQuery("UPDATE tenants SET status = 'active' WHERE id = $1", [s.b.id]);
  });
});

describe('a new clinic writes to its patients in the language of its country', () => {
  const created: string[] = [];
  afterAll(() => destroyTenants(created));

  const clinic = async (phoneCountryCode?: string) => {
    const tag = Math.random().toString(36).slice(2, 8);
    const res = await call<{ id: string }>(api, 'POST', '/api/platform/tenants', {
      token: platformToken,
      body: {
        clinicName: `Klinika ${tag}`,
        subdomain: `lang-${tag}`,
        ownerFullName: 'Pronar Testi',
        ownerEmail: `owner-${tag}@nodex.test`,
        ownerPassword: 'Perkohshem-2026',
        ...(phoneCountryCode ? { phoneCountryCode } : {}),
      },
    });
    expect(res.status).toBe(201);
    created.push(res.body.id);
    const { rows } = await owner().query<{ reminder_locale: string }>(
      'SELECT reminder_locale FROM clinic_settings WHERE tenant_id = $1',
      [res.body.id],
    );
    return rows[0]!.reminder_locale;
  };

  it('in Albanian in Albania, by default, and in Kosovo', async () => {
    expect(await clinic()).toBe('sq');
    expect(await clinic('355')).toBe('sq');
    expect(await clinic('383')).toBe('sq');
  });

  it('in English anywhere else', async () => {
    expect(await clinic('44')).toBe('en');
  });
});

describe('the two planes do not mix', () => {
  it('requires a token for platform routes', async () => {
    const res = await call(api, 'GET', '/api/platform/tenants');

    expect(res.status).toBe(401);
  });

  /**
   * A clinic token carries no `scope: 'platform'`, so PlatformJwtGuard
   * refuses it. Without this, any clinic administrator would be able to list
   * and suspend every other clinic in the deployment.
   */
  it('refuses a clinic token on a platform route', async () => {
    const clinic = await login(api, s.a.subdomain, s.a.adminEmail, s.password);

    const res = await call(api, 'GET', '/api/platform/tenants', {
      token: clinic.accessToken,
    });

    expect(res.status).toBe(401);
  });

  /**
   * And the other direction: a platform token has no tenantId, so
   * JwtAuthGuard refuses it on clinic routes. A console operator does not
   * silently gain a clinic session.
   */
  it('refuses a platform token on a clinic route', async () => {
    const res = await call(api, 'GET', '/api/patients', {
      subdomain: s.a.subdomain,
      token: platformToken,
    });

    expect(res.status).toBe(401);
  });

  /**
   * The two planes now sign with different secrets (PLATFORM_JWT_SECRET),
   * with development falling back to JWT_SECRET. Whichever is configured,
   * crossing the planes must fail — so this asserts the outcome rather than
   * the mechanism, and holds under both arrangements.
   */
  it('refuses a platform token on /api/auth/me', async () => {
    const res = await call(api, 'GET', '/api/auth/me', {
      subdomain: s.a.subdomain,
      token: platformToken,
    });

    expect(res.status).toBe(401);
  });
});

describe('platform sign-in', () => {
  it('identifies the operator', async () => {
    const res = await call<{ email: string }>(api, 'GET', '/api/platform/auth/me', {
      token: platformToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(adminEmail);
  });

  it('refuses the wrong password', async () => {
    const res = await call(api, 'POST', '/api/platform/auth/login', {
      body: { email: adminEmail, password: 'wrong' },
    });

    expect(res.status).toBe(401);
  });
});

/** Pull one field out of whatever envelope a list endpoint uses. */
function collect(body: unknown, field: string): unknown[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((Object.values(body).find(Array.isArray) as unknown[]) ?? [])
      : [];
  return rows.map((r) => (r as Record<string, unknown>)[field]);
}
