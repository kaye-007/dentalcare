import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { PlatformJwtGuard } from '../../platform/platform-auth/platform-jwt.guard';
import { JwtAuthGuard } from './jwt.guard';
import { OwnerGuard } from './owner.guard';

const SECRET = 'test-secret-at-least-32-characters-long';
const config = { get: () => SECRET } as unknown as ConfigService;
const jwt = new JwtService({ secret: SECRET });

function ctxWith(headers: Record<string, string>, store: Record<string, unknown> = {}) {
  const req = { headers, ...store };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
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

describe('OwnerGuard', () => {
  const guard = new OwnerGuard();

  it('allows an owner', () => {
    expect(guard.canActivate(ctxWith({}, { user: { role: 'owner' } }))).toBe(true);
  });

  it('denies frontdesk', () => {
    expect(() =>
      guard.canActivate(ctxWith({}, { user: { role: 'frontdesk' } })),
    ).toThrow(ForbiddenException);
  });

  it('denies an unauthenticated request', () => {
    expect(() => guard.canActivate(ctxWith({}))).toThrow(ForbiddenException);
  });
});
