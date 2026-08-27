import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService, AuthUserRow } from '../users/users.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { BCRYPT_ROUNDS } from '../../core/security/bcrypt';
import { Permission, Role, normalizeRole, permissionsFor } from '../../core/authz/permissions';

export interface AccessTokenPayload {
  sub: string;
  tenantId: string;
  role: Role;
  email: string;
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  tenantId: string;
  clinicName: string;
  /**
   * Resolved server-side so the SPA never re-derives the matrix. Purely for
   * hiding UI the user cannot use — every route is still enforced by
   * PermissionsGuard on the API.
   */
  permissions: Permission[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly tenant: TenantContextService,
  ) {}

  async login(email: string, password: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    const user = await this.users.findForAuthByEmail(tenantId, email);

    const invalid = new UnauthorizedException('Invalid email or password');
    if (!user) throw invalid;

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw invalid;

    if (user.user_status !== 'active') {
      throw new UnauthorizedException('This account is disabled');
    }
    // Tenant suspension is also blocked upstream by the middleware. Allowlist
    // here too, so 'archived' (and any future status) fails closed.
    if (user.tenant_status !== 'active') {
      throw new UnauthorizedException('Clinic access is currently suspended');
    }

    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; type?: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tenantId = this.tenant.getRequiredTenantId();
    const user = await this.users.findForAuthById(tenantId, payload.sub);
    if (!user || user.user_status !== 'active') {
      throw new UnauthorizedException('Account no longer active');
    }

    return { accessToken: await this.signAccess(user) };
  }

  /**
   * Change the caller's own password. Re-verifies the current password so a
   * hijacked session cannot lock the real owner out of their account.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ changed: true }> {
    const tenantId = this.tenant.getRequiredTenantId();
    const user = await this.users.findForAuthById(tenantId, userId);
    if (!user || user.user_status !== 'active') {
      throw new UnauthorizedException();
    }

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    if (await bcrypt.compare(newPassword, user.password_hash)) {
      throw new BadRequestException('New password must be different');
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.users.updatePasswordHash(tenantId, userId, hash);
    return { changed: true };
  }

  /**
   * Issue a session for a user whose identity has already been proven by
   * something other than a password — today, Google.
   *
   * It re-reads the row rather than trusting what the caller passes, so the
   * account status, role and clinic status are all checked against the
   * database at the moment the token is minted, exactly as password login
   * does. The only thing skipped is the bcrypt comparison.
   */
  async issueSessionForUser(tenantId: string, userId: string) {
    const user = await this.users.findForAuthById(tenantId, userId);
    if (!user || user.user_status !== 'active') {
      throw new UnauthorizedException();
    }
    if (user.tenant_status !== 'active') {
      throw new UnauthorizedException('Clinic access is currently suspended');
    }
    return this.issueTokens(user);
  }

  /**
   * Resolve the stored role to a current one. A row whose role cannot be
   * resolved is a data fault; refuse the session rather than guessing.
   */
  private requireRole(user: AuthUserRow): Role {
    const role = normalizeRole(user.role);
    if (!role) {
      throw new UnauthorizedException('Your account has no valid access role');
    }
    return role;
  }

  private async issueTokens(user: AuthUserRow) {
    const accessToken = await this.signAccess(user);
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, type: 'refresh' },
      {
        secret: this.config.get<string>('JWT_SECRET'),
        expiresIn: this.config.get<string>('JWT_REFRESH_TTL'),
      },
    );

    const role = this.requireRole(user);
    const publicUser: PublicUser = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role,
      tenantId: user.tenant_id,
      clinicName: user.clinic_name,
      permissions: permissionsFor(role),
    };
    return { accessToken, refreshToken, user: publicUser };
  }

  private signAccess(user: AuthUserRow) {
    const payload: AccessTokenPayload = {
      sub: user.id,
      tenantId: user.tenant_id,
      role: this.requireRole(user),
      email: user.email,
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.get<string>('JWT_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL'),
    });
  }
}
