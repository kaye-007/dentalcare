import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantContextService } from './tenant-context';
import { ReadOnlyGuard, ALLOW_WHEN_READ_ONLY } from './read-only.guard';

/**
 * The lock that makes `trial_ends_at` mean something. Before this, the column
 * was written on clinic creation, shown in the admin panel, and read by
 * nothing — a 7-day demo ran forever.
 */
function guardFor(opts: { readOnly: boolean; allowed?: boolean }) {
  const tenant = {
    isReadOnly: () => opts.readOnly,
    get: () => ({ trialEndsAt: '2026-08-01T00:00:00.000Z' }),
  } as unknown as TenantContextService;
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === ALLOW_WHEN_READ_ONLY ? opts.allowed : undefined,
  } as unknown as Reflector;
  return new ReadOnlyGuard(tenant, reflector);
}

const ctxWith = (method: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ method }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as unknown as ExecutionContext;

describe('ReadOnlyGuard', () => {
  it('does nothing at all while the trial is live', () => {
    const guard = guardFor({ readOnly: false });
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect(guard.canActivate(ctxWith(m))).toBe(true);
    }
  });

  it('keeps every read working after the trial ends', () => {
    const guard = guardFor({ readOnly: true });
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      expect(guard.canActivate(ctxWith(m))).toBe(true);
    }
  });

  it('refuses every write after the trial ends', () => {
    const guard = guardFor({ readOnly: true });
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(() => guard.canActivate(ctxWith(m))).toThrow(HttpException);
    }
  });

  it('answers 402, not 403 — they are not forbidden, they have not paid', () => {
    const guard = guardFor({ readOnly: true });
    try {
      guard.canActivate(ctxWith('POST'));
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as HttpException;
      expect(e.getStatus()).toBe(402);
      const body = e.getResponse() as { code: string; trialEndsAt: string | null };
      expect(body.code).toBe('trial_expired');
      // The UI needs the date to say "ended on the 1st", not just "ended".
      expect(body.trialEndsAt).toBe('2026-08-01T00:00:00.000Z');
    }
  });

  it('leaves the exemption to the route, not to a hardcoded list', () => {
    // login, refresh and "change my own password" all carry the decorator.
    // Encoding those paths in the guard would mean editing the guard every
    // time one of them moved.
    const guard = guardFor({ readOnly: true, allowed: true });
    for (const m of ['POST', 'PATCH']) {
      expect(guard.canActivate(ctxWith(m))).toBe(true);
    }
  });

  it('still lets them sign in', () => {
    // The one exemption. A clinic locked out of login cannot look at what it
    // built, which is the only argument for paying.
    const guard = guardFor({ readOnly: true, allowed: true });
    expect(guard.canActivate(ctxWith('POST'))).toBe(true);
  });
});
