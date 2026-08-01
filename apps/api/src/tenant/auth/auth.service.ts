import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService, AuthUserRow } from '../users/users.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';

export interface AccessTokenPayload {
  sub: string;
  tenantId: string;
  role: 'owner' | 'frontdesk';
  email: string;
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: 'owner' | 'frontdesk';
  tenantId: string;
  clinicName: string;
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
    // Tenant suspension is also blocked upstream by the middleware.
    if (user.tenant_status === 'suspended' || user.tenant_status === 'cancelled') {
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

  private async issueTokens(user: AuthUserRow) {
    const accessToken = await this.signAccess(user);
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, type: 'refresh' },
      {
        secret: this.config.get<string>('JWT_SECRET'),
        expiresIn: this.config.get<string>('JWT_REFRESH_TTL'),
      },
    );

    const publicUser: PublicUser = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      tenantId: user.tenant_id,
      clinicName: user.clinic_name,
    };
    return { accessToken, refreshToken, user: publicUser };
  }

  private signAccess(user: AuthUserRow) {
    const payload: AccessTokenPayload = {
      sub: user.id,
      tenantId: user.tenant_id,
      role: user.role,
      email: user.email,
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.get<string>('JWT_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL'),
    });
  }
}
