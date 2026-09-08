import { call, login, startApi, TestApi } from './api';
import { closePools, ownerQuery } from './db';
import { createScenario, destroyScenario, Scenario } from './fixtures';

/**
 * Two clinics, over HTTP, with a token from one pointed at the other.
 *
 * This is the audit's headline scenario and it deserves the whole route:
 * clinic A signs in on A, clinic B signs in on B, and then every way of
 * pointing A's credentials at B's data is tried. There are two independent
 * defences and they fail at different layers, which is the point of testing
 * both rather than assuming one covers the other.
 *
 *   token binding   JwtAuthGuard compares payload.tenantId with the clinic
 *                   TenantMiddleware resolved. Wrong pair -> 401, before any
 *                   query runs.
 *
 *   RLS             if a token WERE somehow accepted, the query still runs
 *                   as app_user inside that clinic's context, so the row is
 *                   simply not there -> 404. Not a filter in the service;
 *                   the service has no WHERE clause to check.
 */

let api: TestApi;
let s: Scenario;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  api = await startApi();
  s = await createScenario();
  tokenA = (await login(api, s.a.subdomain, s.a.adminEmail, s.password)).accessToken;
  tokenB = (await login(api, s.b.subdomain, s.b.adminEmail, s.password)).accessToken;
});

afterAll(async () => {
  await destroyScenario(s);
  await api.close();
  await closePools();
});

describe('each clinic sees its own patients', () => {
  it('A lists PA and not PB', async () => {
    const res = await call<{ items?: { id: string }[] }>(api, 'GET', '/api/patients', {
      subdomain: s.a.subdomain,
      token: tokenA,
    });

    expect(res.status).toBe(200);
    const ids = collectIds(res.body);
    expect(ids).toContain(s.a.patientId);
    expect(ids).not.toContain(s.b.patientId);
  });

  it('B lists PB and not PA', async () => {
    const res = await call(api, 'GET', '/api/patients', {
      subdomain: s.b.subdomain,
      token: tokenB,
    });

    expect(res.status).toBe(200);
    const ids = collectIds(res.body);
    expect(ids).toContain(s.b.patientId);
    expect(ids).not.toContain(s.a.patientId);
  });
});

describe('a token is bound to the clinic that issued it', () => {
  /**
   * A's token on B's subdomain. Refused by the guard before a query is
   * issued, so this proves the binding rather than the isolation.
   */
  it('401s A’s token used on B', async () => {
    const res = await call<{ message: string }>(api, 'GET', '/api/patients', {
      subdomain: s.b.subdomain,
      token: tokenA,
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Token does not match this clinic');
  });

  it('401s B’s token used on A', async () => {
    const res = await call(api, 'GET', '/api/patients', {
      subdomain: s.a.subdomain,
      token: tokenB,
    });

    expect(res.status).toBe(401);
  });

  it('401s A’s token against B’s patient by id', async () => {
    const res = await call(api, 'GET', `/api/patients/${s.b.patientId}`, {
      subdomain: s.b.subdomain,
      token: tokenA,
    });

    expect(res.status).toBe(401);
  });
});

describe('isolation underneath the binding', () => {
  /**
   * The important one, and the one that is easy to get wrong in a test.
   *
   * A's token on A's own subdomain — a completely legitimate session — asking
   * for a patient id that belongs to B. The binding does not fire, because
   * the token and the clinic agree. The only thing standing between A and
   * B's medical record is the row-level policy, and the answer must be 404.
   *
   * To prove the 404 comes from the database and not from a service that
   * happens to filter, the same id is read back as the owner immediately
   * afterwards: the row exists, it is simply invisible to A.
   */
  it('404s a patient belonging to another clinic', async () => {
    const res = await call(api, 'GET', `/api/patients/${s.b.patientId}`, {
      subdomain: s.a.subdomain,
      token: tokenA,
    });

    expect(res.status).toBe(404);

    const { rows } = await ownerQuery('SELECT id FROM patients WHERE id = $1', [
      s.b.patientId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('404s an id that exists in no clinic, identically', async () => {
    const res = await call(api, 'GET', `/api/patients/${s.b.patientId}`, {
      subdomain: s.a.subdomain,
      token: tokenA,
    });
    const absent = await call(
      api,
      'GET',
      '/api/patients/00000000-0000-0000-0000-000000000000',
      { subdomain: s.a.subdomain, token: tokenA },
    );

    // Same status either way — otherwise the difference tells A that B's
    // patient exists, which is the fact being protected.
    expect(res.status).toBe(absent.status);
  });

  /**
   * Writing, not reading. A creates a patient while authenticated to A; the
   * row can only land in A. There is no tenant_id in the DTO to tamper with —
   * the service takes it from the request context — and WITH CHECK is what
   * makes that structurally true rather than merely current practice.
   */
  it('a patient created by A belongs to A', async () => {
    const res = await call<{ id: string }>(api, 'POST', '/api/patients', {
      subdomain: s.a.subdomain,
      token: tokenA,
      body: { firstName: 'Created', lastName: 'ByA' },
    });

    expect(res.status).toBe(201);

    const { rows } = await ownerQuery<{ tenant_id: string }>(
      'SELECT tenant_id FROM patients WHERE id = $1',
      [res.body.id],
    );
    expect(rows[0].tenant_id).toBe(s.a.id);
    expect(rows[0].tenant_id).not.toBe(s.b.id);
  });

  /**
   * The DTO strips unknown fields and forbidNonWhitelisted rejects them, so a
   * client-supplied tenantId never reaches the service. This asserts the
   * refusal rather than the silent strip: a caller must not be able to
   * discover which extra fields are tolerated.
   */
  it('refuses a create that tries to name another clinic', async () => {
    const res = await call(api, 'POST', '/api/patients', {
      subdomain: s.a.subdomain,
      token: tokenA,
      body: { firstName: 'Smuggled', lastName: 'Row', tenantId: s.b.id },
    });

    expect(res.status).toBe(400);
  });

  it('A cannot update B’s patient', async () => {
    const res = await call(api, 'PATCH', `/api/patients/${s.b.patientId}`, {
      subdomain: s.a.subdomain,
      token: tokenA,
      body: { firstName: 'Hijacked' },
    });

    expect(res.status).toBe(404);

    const { rows } = await ownerQuery<{ first_name: string }>(
      'SELECT first_name FROM patients WHERE id = $1',
      [s.b.patientId],
    );
    expect(rows[0].first_name).toBe('Test');
  });
});

describe('the clinic must be identified at all', () => {
  /**
   * With ALLOW_TENANT_HEADER set and no header, TenantMiddleware falls back
   * to DEV_TENANT_SUBDOMAIN; with neither, 127.0.0.1 has no subdomain to read
   * and the request cannot name a clinic. It must be refused rather than
   * defaulting to one.
   */
  it('refuses a request that names no clinic', async () => {
    const previous = process.env.DEV_TENANT_SUBDOMAIN;
    delete process.env.DEV_TENANT_SUBDOMAIN;
    try {
      const res = await fetch(api.url('/api/patients'), {
        headers: { Authorization: `Bearer ${tokenA}` },
      });

      expect([400, 401, 404]).toContain(res.status);
      expect(res.status).not.toBe(200);
    } finally {
      if (previous !== undefined) process.env.DEV_TENANT_SUBDOMAIN = previous;
    }
  });
});

/** The list endpoints wrap their rows differently; find the array either way. */
function collectIds(body: unknown): string[] {
  if (Array.isArray(body)) return body.map((r) => (r as { id: string }).id);
  if (body && typeof body === 'object') {
    const array = Object.values(body).find(Array.isArray) as { id: string }[] | undefined;
    if (array) return array.map((r) => r.id);
  }
  return [];
}
