import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../../core/database/database.service';

export interface PlatformTokenPayload {
  sub: string;
  scope: 'platform';
  email: string;
}

interface AdminRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  status: 'active' | 'disabled';
}

@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string) {
    const { rows } = await this.db.adminQuery<AdminRow>(
      `SELECT id, email, password_hash, full_name, status
         FROM platform_admins
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email],
    );
    const admin = rows[0];
    const invalid = new UnauthorizedException('Invalid email or password');
    if (!admin) throw invalid;

    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) throw invalid;
    if (admin.status !== 'active') {
      throw new UnauthorizedException('This account is disabled');
    }

    const payload: PlatformTokenPayload = {
      sub: admin.id,
      scope: 'platform',
      email: admin.email,
    };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>('JWT_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL'),
    });

    return {
      accessToken,
      admin: { id: admin.id, email: admin.email, fullName: admin.full_name },
    };
  }

  /** Look up a console administrator by email, for Google sign-in. */
  async findForOAuth(email: string) {
    const { rows } = await this.db.adminQuery<
      AdminRow & { google_sub: string | null }
    >(
      `SELECT id, email, password_hash, full_name, status, google_sub
         FROM platform_admins
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email],
    );
    return rows[0] ?? null;
  }

  /** Record the Google subject on first sign-in. */
  async linkGoogle(id: string, googleSub: string): Promise<void> {
    await this.db.adminQuery(
      `UPDATE platform_admins
          SET google_sub = $2, google_linked_at = now(), updated_at = now()
        WHERE id = $1 AND google_sub IS NULL`,
      [id, googleSub],
    );
  }

  /**
   * Mint a console token for an identity already proven by Google. Re-reads
   * the row so status is checked at the moment of issue, exactly as password
   * login does.
   */
  async issueForAdmin(id: string) {
    const { rows } = await this.db.adminQuery<AdminRow>(
      `SELECT id, email, password_hash, full_name, status
         FROM platform_admins WHERE id = $1`,
      [id],
    );
    const admin = rows[0];
    if (!admin || admin.status !== 'active') throw new UnauthorizedException();

    const payload: PlatformTokenPayload = {
      sub: admin.id,
      scope: 'platform',
      email: admin.email,
    };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>('JWT_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL'),
    });
    return {
      accessToken,
      admin: { id: admin.id, email: admin.email, fullName: admin.full_name },
    };
  }

  async me(id: string) {
    const { rows } = await this.db.adminQuery<AdminRow>(
      `SELECT id, email, full_name, status FROM platform_admins WHERE id = $1`,
      [id],
    );
    const admin = rows[0];
    if (!admin) throw new UnauthorizedException();
    return { id: admin.id, email: admin.email, fullName: admin.full_name };
  }
}
