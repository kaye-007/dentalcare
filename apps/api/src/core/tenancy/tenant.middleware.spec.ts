import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from './tenant-context';
import { TenantMiddleware } from './tenant.middleware';

/**
 * Regression tests for the two tenancy gates that had drifted from the schema:
 *
 *  - status was checked with a denylist naming 'cancelled' (unreachable after
 *    migration 0004) and never naming 'archived', so the admin console's
 *    Archive button revoked nothing.
 *  - the X-Tenant-Subdomain header was enabled by the *absence* of
 *    NODE_ENV=production, which fails open.
 */
function makeMiddleware(opts: {
  env?: Record<string, string | undefined>;
  tenant?: { id: string; status: string; trial_ends_at?: Date | null } | null;
}) {
  const rows = opts.tenant ? [opts.tenant] : [];
  const db = {
    query: jest.fn().mockResolvedValue({ rows }),
  } as unknown as DatabaseService;
  const config = {
    get: (key: string) => opts.env?.[key],
  } as unknown as ConfigService;
  const ctx = new TenantContextService();
  return {
    middleware: new TenantMiddleware(db, ctx, config),
    db,
    ctx,
  };
}

const req = (headers: Record<string, string> = {}) =>
  ({ headers: { host: 'localhost:3000', ...headers } }) as unknown as Request;

const res = {} as Response;

describe('TenantMiddleware — tenant status gate', () => {
  const env = { ALLOW_TENANT_HEADER: '1', DEV_TENANT_SUBDOMAIN: 'avicena' };

  it('allows an active tenant through', async () => {
    const { middleware } = makeMiddleware({
      env,
      tenant: { id: 'tid-1', status: 'active' },
    });
    const next = jest.fn();
    await middleware.use(req(), res, next);
    expect(next).toHaveBeenCalled();
  });

  // The bug: 'archived' fell through the old denylist entirely.
  it.each(['archived', 'suspended', 'cancelled', 'trial', 'something_new'])(
    'denies a tenant with status "%s"',
    async (status) => {
      const { middleware } = makeMiddleware({ env, tenant: { id: 'tid-1', status } });
      const next = jest.fn();
      await expect(middleware.use(req(), res, next)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(next).not.toHaveBeenCalled();
    },
  );

  it('404s an unknown subdomain', async () => {
    const { middleware } = makeMiddleware({ env, tenant: null });
    await expect(middleware.use(req(), res, jest.fn())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('exposes the resolved tenant to downstream code', async () => {
    const { middleware, ctx } = makeMiddleware({
      env,
      tenant: { id: 'tid-42', status: 'active' },
    });
    let seen: string | undefined;
    await middleware.use(req(), res, () => {
      seen = ctx.getTenantId();
    });
    expect(seen).toBe('tid-42');
  });
});

describe('TenantMiddleware — the unknown-clinic message', () => {
  /**
   * "Clinic not found." was true and unhelpful. The common way to reach it
   * is local — DEV_TENANT_SUBDOMAIN naming a clinic that was never created —
   * and it fires before AuthService runs, so it reads as a broken login for
   * a password that was never compared.
   */
  it('names the subdomain and where it came from, in development', async () => {
    const { middleware } = makeMiddleware({
      env: { ALLOW_TENANT_HEADER: '1', DEV_TENANT_SUBDOMAIN: 'demo' },
      tenant: null,
    });
    await expect(middleware.use(req(), res, jest.fn())).rejects.toThrow(
      /No clinic with subdomain "demo".*DEV_TENANT_SUBDOMAIN in .env/s,
    );
  });

  it('names the header when the header chose the clinic', async () => {
    const { middleware } = makeMiddleware({
      env: { ALLOW_TENANT_HEADER: '1', DEV_TENANT_SUBDOMAIN: 'demo' },
      tenant: null,
    });
    await expect(
      middleware.use(req({ 'x-tenant-subdomain': 'smile' }), res, jest.fn()),
    ).rejects.toThrow(/No clinic with subdomain "smile".*X-Tenant-Subdomain/s);
  });

  /**
   * Production says nothing extra. The caller controls the Host header, so a
   * message confirming which subdomains do and do not exist is free tenant
   * enumeration against a public endpoint.
   */
  it('stays terse in production and leaks no subdomain', async () => {
    const { middleware } = makeMiddleware({
      env: { NODE_ENV: 'production' },
      tenant: null,
    });
    const error = await middleware
      .use(
        { headers: { host: 'probe.dentalcare.app' } } as unknown as Request,
        res,
        jest.fn(),
      )
      .then(
        () => null,
        (e: Error) => e,
      );

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error!.message).toBe('Clinic not found.');
    expect(error!.message).not.toMatch(/probe|DEV_TENANT_SUBDOMAIN|dev:setup/);
  });
});

describe('TenantMiddleware — subdomain resolution', () => {
  it('honours X-Tenant-Subdomain when explicitly allowed', async () => {
    const { middleware, db } = makeMiddleware({
      env: { ALLOW_TENANT_HEADER: '1' },
      tenant: { id: 'tid-1', status: 'active' },
    });
    await middleware.use(req({ 'x-tenant-subdomain': 'smile' }), res, jest.fn());
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ['smile']);
  });

  // The fix: opt-in, not opt-out.
  it('ignores the header when ALLOW_TENANT_HEADER is unset', async () => {
    const { middleware } = makeMiddleware({
      env: {},
      tenant: { id: 'tid-1', status: 'active' },
    });
    // No header honoured and no dev fallback -> host has no subdomain -> reject.
    await expect(
      middleware.use(req({ 'x-tenant-subdomain': 'smile' }), res, jest.fn()),
    ).rejects.toThrow(/determine the clinic/);
  });

  it('ignores the header in production even when the flag is set', async () => {
    const { middleware, db } = makeMiddleware({
      env: { NODE_ENV: 'production', ALLOW_TENANT_HEADER: '1' },
      tenant: { id: 'tid-1', status: 'active' },
    });
    await middleware.use(
      {
        headers: { host: 'avicena.dentalcare.app', 'x-tenant-subdomain': 'smile' },
      } as unknown as Request,
      res,
      jest.fn(),
    );
    // Resolved from Host, not from the attacker-controlled header.
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ['avicena']);
  });

  it('reads the subdomain from Host in production', async () => {
    const { middleware, db } = makeMiddleware({
      env: { NODE_ENV: 'production' },
      tenant: { id: 'tid-1', status: 'active' },
    });
    await middleware.use(
      { headers: { host: 'smile.dentalcare.app:443' } } as unknown as Request,
      res,
      jest.fn(),
    );
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ['smile']);
  });

  it('does not treat www as a tenant', async () => {
    const { middleware } = makeMiddleware({
      env: { NODE_ENV: 'production' },
      tenant: { id: 'tid-1', status: 'active' },
    });
    await expect(
      middleware.use(
        { headers: { host: 'www.dentalcare.app' } } as unknown as Request,
        res,
        jest.fn(),
      ),
    ).rejects.toThrow(/determine the clinic/);
  });
});

describe('TenantMiddleware — trial resolution', () => {
  const env = { ALLOW_TENANT_HEADER: '1', DEV_TENANT_SUBDOMAIN: 'avicena' };
  const DAY = 86_400_000;

  /** Runs the middleware and hands back the context it established. */
  async function contextFor(trial_ends_at: Date | null) {
    const { middleware, ctx } = makeMiddleware({
      env,
      tenant: { id: 'tid-1', status: 'active', trial_ends_at },
    });
    let seen: ReturnType<TenantContextService['get']>;
    await middleware.use(req(), res, () => {
      seen = ctx.get();
    });
    return seen!;
  }

  it('leaves a paying clinic unrestricted', async () => {
    const c = await contextFor(null);
    expect(c.trialEndsAt).toBeNull();
    expect(c.readOnly).toBe(false);
  });

  it('leaves a running trial unrestricted', async () => {
    const c = await contextFor(new Date(Date.now() + 3 * DAY));
    expect(c.readOnly).toBe(false);
    expect(c.trialEndsAt).not.toBeNull();
  });

  it('marks an expired trial read-only', async () => {
    const c = await contextFor(new Date(Date.now() - 1 * DAY));
    expect(c.readOnly).toBe(true);
  });

  it('does not confuse an expired trial with a suspension', async () => {
    // The clinic still resolves and still gets a context. Losing writes is a
    // different thing from losing the account, and the middleware must not
    // collapse the two — an expired trial that 403s at the door can never
    // show the prospect the data that would sell them the subscription.
    const { middleware } = makeMiddleware({
      env,
      tenant: {
        id: 'tid-1',
        status: 'active',
        trial_ends_at: new Date(Date.now() - DAY),
      },
    });
    const next = jest.fn();
    await middleware.use(req(), res, next);
    expect(next).toHaveBeenCalled();
  });
});
