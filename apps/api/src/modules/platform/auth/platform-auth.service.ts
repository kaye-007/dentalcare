import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '@/core/database/database.service';
import { AuthThrottleService } from '@/core/auth-throttle/auth-throttle.service';
import { NO_SUCH_ACCOUNT_HASH } from '@/core/security/bcrypt';
import { MfaService, mfaFailureMessage } from '@/core/mfa/mfa.service';
import {
  createSession,
  revokeByToken,
  rotateSession,
} from '@/core/sessions/session-store';
import { durationMs } from '@/core/sessions/session-tokens';
import { platformJwtSecret } from './platform-secret';

export interface PlatformTokenPayload {
  sub: string;
  scope: 'platform';
  email: string;
  /** The platform_sessions row this token was minted for (0005). */
  sid?: string;
}

interface AdminRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  status: 'active' | 'disabled';
}

export interface RequestMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface PlatformAuthenticated {
  status: 'authenticated';
  accessToken: string;
  refreshToken: string;
  admin: { id: string; email: string; fullName: string };
}

export type PlatformLoginResult =
  | PlatformAuthenticated
  | { status: 'mfa_required'; challengeToken: string; methods: ('totp' | 'recovery')[] }
  | { status: 'mfa_enrollment_required'; challengeToken: string };

type ChallengeStage = 'verify' | 'enroll';

/**
 * Deliberately NOT scope 'platform': PlatformJwtGuard admits exactly that
 * scope, so a challenge token — which proves a password and nothing more —
 * can never open a console route.
 */
interface PlatformChallenge {
  sub: string;
  scope: 'platform_mfa';
  stage: ChallengeStage;
}

const CHALLENGE_TTL = '10m';
const EXPIRED_CHALLENGE = 'This sign-in has expired. Please start again.';

/**
 * Console sign-in.
 *
 * A console account is authority over every clinic in the deployment, so
 * two-step sign-in is not a policy here: with MFA_ENFORCEMENT=required (the
 * only value production accepts) every console account must enrol before its
 * first session is issued. Sessions are rows in platform_sessions and rotate
 * exactly as clinic sessions do — see core/sessions/session-store.ts.
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mfa: MfaService,
    private readonly throttle: AuthThrottleService,
  ) {}

  async login(
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<PlatformLoginResult> {
    // Counted in the database (0025), like a clinic sign-in.
    const keys = this.throttle.keys('platform', email);
    await this.throttle.assertOpen('admin', keys);

    const { rows } = await this.db.adminQuery<AdminRow>(
      `SELECT id, email, password_hash, full_name, status
         FROM platform_admins
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email],
    );
    const admin = rows[0];
    // Same bcrypt work for an unknown address as for a wrong password.
    const ok = await bcrypt.compare(
      password,
      admin?.password_hash ?? NO_SUCH_ACCOUNT_HASH,
    );
    if (!admin || !ok) {
      await this.throttle.failed('admin', keys);
      throw new UnauthorizedException('Invalid email or password');
    }
    await this.throttle.succeeded('admin', keys);
    if (admin.status !== 'active') {
      throw new UnauthorizedException('This account is disabled');
    }
    return this.continueSignIn(admin, meta);
  }

  private async findById(id: string): Promise<AdminRow | null> {
    const { rows } = await this.db.adminQuery<AdminRow>(
      `SELECT id, email, password_hash, full_name, status
         FROM platform_admins WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  private async continueSignIn(
    admin: AdminRow,
    meta: RequestMeta,
  ): Promise<PlatformLoginResult> {
    const { enrolled } = await this.db.withAdminTransaction((c) =>
      this.mfa.status(c, 'platform', admin.id),
    );
    if (enrolled) {
      return {
        status: 'mfa_required',
        challengeToken: await this.challenge(admin, 'verify'),
        methods: ['totp', 'recovery'],
      };
    }
    if (this.config.get<string>('MFA_ENFORCEMENT') !== 'optional') {
      return {
        status: 'mfa_enrollment_required',
        challengeToken: await this.challenge(admin, 'enroll'),
      };
    }
    return this.issueTokens(admin, meta, null);
  }

  private challenge(admin: AdminRow, stage: ChallengeStage): Promise<string> {
    const claims: PlatformChallenge = { sub: admin.id, scope: 'platform_mfa', stage };
    return this.jwt.signAsync(claims, {
      secret: platformJwtSecret(this.config),
      expiresIn: CHALLENGE_TTL,
    });
  }

  private async readChallenge(token: string, stage: ChallengeStage): Promise<AdminRow> {
    let claims: PlatformChallenge;
    try {
      claims = await this.jwt.verifyAsync<PlatformChallenge>(token, {
        secret: platformJwtSecret(this.config),
      });
    } catch {
      throw new UnauthorizedException(EXPIRED_CHALLENGE);
    }
    if (claims.scope !== 'platform_mfa' || claims.stage !== stage) {
      throw new UnauthorizedException(EXPIRED_CHALLENGE);
    }
    const admin = await this.findById(claims.sub);
    if (!admin || admin.status !== 'active')
      throw new UnauthorizedException(EXPIRED_CHALLENGE);
    return admin;
  }

  async verifyMfa(
    challengeToken: string,
    input: { code?: string; recoveryCode?: string },
    meta: RequestMeta,
  ): Promise<PlatformAuthenticated> {
    if (Boolean(input.code) === Boolean(input.recoveryCode)) {
      throw new BadRequestException(
        'Enter the code from your authenticator app, or one recovery code.',
      );
    }
    const admin = await this.readChallenge(challengeToken, 'verify');
    const verdict = await this.db.withAdminTransaction((c) =>
      this.mfa.verify(c, 'platform', {
        ownerId: admin.id,
        code: input.code,
        recoveryCode: input.recoveryCode,
        nowMs: Date.now(),
      }),
    );
    // After the commit, so the failure count stands. See MfaService.verify.
    if (!verdict.ok) throw new UnauthorizedException(mfaFailureMessage(verdict.reason));
    return this.issueTokens(admin, meta, new Date());
  }

  async beginEnrollment(challengeToken: string) {
    const admin = await this.readChallenge(challengeToken, 'enroll');
    return this.db.withAdminTransaction((c) =>
      this.mfa.beginTotp(c, 'platform', {
        ownerId: admin.id,
        account: admin.email,
        issuer: 'DentalCare Console',
      }),
    );
  }

  async confirmEnrollment(challengeToken: string, code: string, meta: RequestMeta) {
    const admin = await this.readChallenge(challengeToken, 'enroll');
    const { recoveryCodes } = await this.db.withAdminTransaction((c) =>
      this.mfa.confirmTotp(c, 'platform', { ownerId: admin.id, code, nowMs: Date.now() }),
    );
    return { ...(await this.issueTokens(admin, meta, new Date())), recoveryCodes };
  }

  async refresh(refreshToken: string, meta: RequestMeta) {
    const result = await this.db.withAdminTransaction((c) =>
      rotateSession(c, 'platform_sessions', refreshToken, {
        userAgent: meta.userAgent,
        ip: meta.ip,
        ownerIsActive: async (id) => (await this.findById(id))?.status === 'active',
      }),
    );
    if (!result.ok) {
      throw new UnauthorizedException(
        result.reason === 'reused'
          ? 'This session was ended because its sign-in token was used twice. Please sign in again.'
          : 'Invalid refresh token',
      );
    }
    const admin = await this.findById(result.ownerId);
    if (!admin) throw new UnauthorizedException('Invalid refresh token');
    return {
      accessToken: await this.signAccess(admin, result.next.sessionId),
      refreshToken: result.next.refreshToken,
    };
  }

  async logout(refreshToken: string): Promise<{ signedOut: true }> {
    await this.db.withAdminTransaction((c) =>
      revokeByToken(c, 'platform_sessions', refreshToken, 'logout'),
    );
    return { signedOut: true };
  }

  /** Look up a console administrator by email, for Google sign-in. */
  async findForOAuth(email: string) {
    const { rows } = await this.db.adminQuery<AdminRow & { google_sub: string | null }>(
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
   * Continue a sign-in whose first factor Google proved. Re-reads the row so
   * status is checked at the moment of issue, and goes through the same MFA
   * decision as a password: Google does not skip the second factor.
   */
  async issueForAdmin(id: string, meta: RequestMeta = {}): Promise<PlatformLoginResult> {
    const admin = await this.findById(id);
    if (!admin || admin.status !== 'active') throw new UnauthorizedException();
    return this.continueSignIn(admin, meta);
  }

  async me(id: string) {
    const admin = await this.findById(id);
    if (!admin) throw new UnauthorizedException();
    return { id: admin.id, email: admin.email, fullName: admin.full_name };
  }

  private async issueTokens(
    admin: AdminRow,
    meta: RequestMeta,
    mfaVerifiedAt: Date | null,
  ): Promise<PlatformAuthenticated> {
    const lifetime = durationMs(this.config.get<string>('JWT_REFRESH_TTL') ?? '7d');
    const session = await this.db.withAdminTransaction((c) =>
      createSession(c, 'platform_sessions', {
        ownerId: admin.id,
        expiresAt: new Date(Date.now() + lifetime),
        mfaVerifiedAt,
        userAgent: meta.userAgent,
        ip: meta.ip,
      }),
    );
    return {
      status: 'authenticated',
      accessToken: await this.signAccess(admin, session.sessionId),
      refreshToken: session.refreshToken,
      admin: { id: admin.id, email: admin.email, fullName: admin.full_name },
    };
  }

  private signAccess(admin: AdminRow, sessionId: string) {
    const payload: PlatformTokenPayload = {
      sub: admin.id,
      scope: 'platform',
      email: admin.email,
      sid: sessionId,
    };
    return this.jwt.signAsync(payload, {
      secret: platformJwtSecret(this.config),
      // Cast: @nestjs/jwt 11 wants ms's StringValue; see AuthService.signAccess.
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL') as JwtSignOptions['expiresIn'],
    });
  }
}
