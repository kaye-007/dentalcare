import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { PlatformJwtGuard } from '@/modules/platform/auth';
import { JwtAuthGuard } from './jwt.guard';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { PERMISSIONS_METADATA_KEY } from '@/core/authz/permissions.decorator';

const SECRET = 'test-secret-at-least-32-characters-long';
const config = { get: () => SECRET } as unknown as ConfigService;
const jwt = new JwtService({ secret: SECRET });

function ctxWith(headers: Record<string, string>, store: Record<string, unknown> = {}) {
  const req = { headers, ...store };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    // Reflector-based guards read metadata off the handler and class.
    getHandler: () =>
      function handler() {
        /* route stand-in */
      },
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

function tenantCtx(id: string | undefined) {
  return { getTenantId: () => id } as unknown as TenantContextService;
}

describe('JwtAuthGuard', () => {
  const guard = (tenantId?: string) => new JwtAuthGuard(jwt, config, tenantCtx(tenantId));

  it('accepts a token issued for the resolved tenant', async () => {
    const token = jwt.sign({ sub: 'u1', tenantId: 't1', role: 'owner', email: 'a@b.c' });
    await expect(
      guard('t1').canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).resolves.toBe(true);
  });

  // Token-to-tenant binding: a valid token for clinic A is inert on clinic B.
  it('rejects a token issued for a different tenant', async () => {
    const token = jwt.sign({ sub: 'u1', tenantId: 't1', role: 'owner', email: 'a@b.c' });
    await expect(
      guard('t2').canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // Cross-plane confusion: a platform token carries no tenantId.
  it('rejects a platform token on a clinic route', async () => {
    const token = jwt.sign({ sub: 'admin', scope: 'platform', email: 'a@nodex.al' });
    await expect(
      guard('t1').canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a refresh token used as an access token', async () => {
    const token = jwt.sign({ sub: 'u1', tenantId: 't1', type: 'refresh' });
    await expect(
      guard('t1').canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token signed with a different secret', async () => {
    const foreign = new JwtService({ secret: 'a-completely-different-secret-value-xx' });
    const token = foreign.sign({ sub: 'u1', tenantId: 't1', role: 'owner' });
    await expect(
      guard('t1').canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([{}, { authorization: 'Basic abc' }, { authorization: 'Bearer' }])(
    'rejects malformed authorization headers (%j)',
    async (headers) => {
      await expect(
        guard('t1').canActivate(ctxWith(headers as Record<string, string>)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );
});

describe('PlatformJwtGuard', () => {
  const guard = new PlatformJwtGuard(jwt, config);

  it('accepts a platform-scoped token', async () => {
    const token = jwt.sign({ sub: 'admin', scope: 'platform', email: 'a@nodex.al' });
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).resolves.toBe(true);
  });

  // The other direction of cross-plane confusion.
  it('rejects a clinic token on a platform route', async () => {
    const token = jwt.sign({ sub: 'u1', tenantId: 't1', role: 'owner', email: 'a@b.c' });
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${token}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('PermissionsGuard', () => {
  /** Builds a guard whose reflector reports `required` for any handler. */
  function guardRequiring(required?: string[]) {
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === PERMISSIONS_METADATA_KEY ? required : undefined,
    } as unknown as Reflector;
    return new PermissionsGuard(reflector);
  }

  it('allows a route that declares no permissions', () => {
    expect(
      guardRequiring(undefined).canActivate(
        ctxWith({}, { user: { role: 'receptionist' } }),
      ),
    ).toBe(true);
    expect(
      guardRequiring([]).canActivate(ctxWith({}, { user: { role: 'receptionist' } })),
    ).toBe(true);
  });

  it('allows admin through every gate', () => {
    for (const perm of [
      'staff:manage',
      'payroll:manage',
      'reports:read',
      'invoices:delete',
      'settings:manage',
    ]) {
      expect(
        guardRequiring([perm]).canActivate(ctxWith({}, { user: { role: 'admin' } })),
      ).toBe(true);
    }
  });

  /**
   * 0009: reception reads the chart and the plans and takes the intake
   * history, but writes neither the odontogram, a perio exam nor a plan.
   */
  it('lets reception read the chart and take a history, but not write the chart or a plan', () => {
    for (const perm of ['clinical:read', 'history:write', 'invoices:fiscalize']) {
      expect(
        guardRequiring([perm]).canActivate(
          ctxWith({}, { user: { role: 'receptionist' } }),
        ),
      ).toBe(true);
    }
    for (const perm of ['clinical:write', 'clinical:sign', 'plans:write']) {
      expect(() =>
        guardRequiring([perm]).canActivate(
          ctxWith({}, { user: { role: 'receptionist' } }),
        ),
      ).toThrow(ForbiddenException);
    }
  });

  it('denies reception wages and the aggregate finances', () => {
    for (const perm of ['payroll:read', 'payroll:manage', 'reports:read']) {
      expect(() =>
        guardRequiring([perm]).canActivate(
          ctxWith({}, { user: { role: 'receptionist' } }),
        ),
      ).toThrow(ForbiddenException);
    }
  });

  it('treats a dentist as a dentist, never as the administrator', () => {
    // 0003_clinical-roles made `dentist` a real, narrower role again. The
    // pre-0017 mapping to admin would now promote every associate.
    for (const perm of ['clinical:write', 'clinical:sign']) {
      expect(
        guardRequiring([perm]).canActivate(ctxWith({}, { user: { role: 'dentist' } })),
      ).toBe(true);
    }
    for (const perm of ['payroll:read', 'reports:read', 'staff:manage']) {
      expect(() =>
        guardRequiring([perm]).canActivate(ctxWith({}, { user: { role: 'dentist' } })),
      ).toThrow(ForbiddenException);
    }
  });

  it('never lets reception or an assistant sign a clinical entry', () => {
    for (const role of ['receptionist', 'assistant']) {
      expect(() =>
        guardRequiring(['clinical:sign']).canActivate(ctxWith({}, { user: { role } })),
      ).toThrow(ForbiddenException);
    }
  });

  it('denies a receptionist the reports dashboard and treatment repricing', () => {
    for (const perm of [
      'reports:read',
      'treatments:manage',
      'invoices:delete',
      'settings:manage',
    ]) {
      expect(() =>
        guardRequiring([perm]).canActivate(
          ctxWith({}, { user: { role: 'receptionist' } }),
        ),
      ).toThrow(ForbiddenException);
    }
  });

  it('requires ALL listed permissions, not merely one', () => {
    // A receptionist holds invoices:write but not invoices:delete.
    expect(() =>
      guardRequiring(['invoices:write', 'invoices:delete']).canActivate(
        ctxWith({}, { user: { role: 'receptionist' } }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('accepts legacy roles at their equivalent authority', () => {
    expect(
      guardRequiring(['payroll:manage']).canActivate(
        ctxWith({}, { user: { role: 'owner' } }),
      ),
    ).toBe(true);
    expect(() =>
      guardRequiring(['reports:read']).canActivate(
        ctxWith({}, { user: { role: 'frontdesk' } }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('fails closed on an unknown role', () => {
    expect(() =>
      guardRequiring(['patients:read']).canActivate(
        ctxWith({}, { user: { role: 'superuser' } }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects an unauthenticated request', () => {
    expect(() => guardRequiring(['patients:read']).canActivate(ctxWith({}))).toThrow(
      UnauthorizedException,
    );
  });
});
