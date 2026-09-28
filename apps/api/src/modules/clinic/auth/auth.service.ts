import type { AccessTokenPayload } from '@/shared/types/access-token';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PoolClient } from 'pg';
import { UsersService, AuthUserRow } from '@/modules/clinic/users';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { DatabaseService } from '@/core/database/database.service';
import { BCRYPT_ROUNDS } from '@/core/security/bcrypt';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { MfaService, mfaFailureMessage } from '@/core/mfa/mfa.service';
import { clinicCurrency } from '@/core/money/clinic-currency';
import {
  createSession,
  familyOf,
  listActive,
  revokeAllFor,
  revokeByToken,
  revokeFamily,
  rotateSession,
} from '@/core/sessions/session-store';
import { durationMs } from '@/core/sessions/session-tokens';
import { Permission, Role, normalizeRole, permissionsFor } from '@dentalcare/shared';

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

/** What a browser tells us about itself at sign-in, kept on the session. */
export interface RequestMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface AuthenticatedResult {
  status: 'authenticated';
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

/**
 * A sign-in either completes, or stops for a second factor. The challenge
 * token that comes back proves the password and nothing more: it opens no
 * route (JwtAuthGuard refuses every typed token), lives ten minutes, and can
 * only be spent on the next step.
 */
export type LoginResult =
  | AuthenticatedResult
  | { status: 'mfa_required'; challengeToken: string; methods: ('totp' | 'recovery')[] }
  | { status: 'mfa_enrollment_required'; challengeToken: string };

type ChallengeStage = 'verify' | 'enroll';

interface ChallengeClaims {
  sub: string;
  tenantId: string;
  type: 'mfa_challenge';
  stage: ChallengeStage;
}

const CHALLENGE_TTL = '10m';
const EXPIRED_CHALLENGE = 'This sign-in has expired. Please start again.';

/**
 * Clinic sign-in, sessions and two-step sign-in.
 *
 * ── The flow ──────────────────────────────────────────────────────────────
 *
 *   password (or Google)
 *     -> enrolled?                  -> challenge 'verify'  -> code  -> session
 *     -> required but not enrolled? -> challenge 'enroll'  -> setup -> session
 *     -> otherwise                                                  -> session
 *
 * MFA is required for administrators, and for everyone at a clinic that has
 * turned `mfa_required_for_all` on. MFA_ENFORCEMENT=optional (development and
 * tests only; production refuses it) lifts the requirement but still
 * challenges anyone who has enrolled.
 *
 * ── Sessions ──────────────────────────────────────────────────────────────
 *
 * Every completed sign-in is a row in user_sessions; see session-store.ts.
 * Access tokens stay stateless and short (JWT_ACCESS_TTL): revoking a session
 * stops the next refresh, not the access token already in hand. That bounds a
 * revoked session to at most one access-token lifetime without a database
 * read on every request — on Workers every read is a new connection.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly tenant: TenantContextService,
    private readonly db: DatabaseService,
    private readonly mfa: MfaService,
    private readonly audit: ClinicAuditService,
  ) {}

  /* ─────────────────────────── sign-in ─────────────────────────── */

  async login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const tenantId = this.tenant.getRequiredTenantId();
    const user = await this.users.findForAuthByEmail(tenantId, email);

    const invalid = new UnauthorizedException('Invalid email or password');
    if (!user) throw invalid;

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw invalid;

    this.assertMaySignIn(user);
    return this.continueSignIn(user, meta);
  }

  /**
   * Continue a sign-in whose first factor was proven by something other than
   * a password — today, Google. Re-reads the row rather than trusting the
   * caller, and goes through exactly the same second-factor decision: signing
   * in with Google does not skip MFA.
   */
  async issueSessionForUser(
    tenantId: string,
    userId: string,
    meta: RequestMeta = {},
  ): Promise<LoginResult> {
    const user = await this.users.findForAuthById(tenantId, userId);
    if (!user) throw new UnauthorizedException();
    this.assertMaySignIn(user);
    return this.continueSignIn(user, meta);
  }

  private assertMaySignIn(user: AuthUserRow): Role {
    if (user.user_status !== 'active') {
      throw new UnauthorizedException('This account is disabled');
    }
    // Tenant suspension is also blocked upstream by the middleware. Allowlist
    // here too, so 'archived' (and any future status) fails closed.
    if (user.tenant_status !== 'active') {
      throw new UnauthorizedException('Clinic access is currently suspended');
    }
    return this.requireRole(user);
  }

  private async continueSignIn(user: AuthUserRow, meta: RequestMeta): Promise<LoginResult> {
    const { enrolled, required } = await this.db.withTenant(user.tenant_id, async (c) => ({
      enrolled: (await this.mfa.status(c, 'clinic', user.id)).enrolled,
      required: await this.mfaRequired(c, user),
    }));

    if (enrolled) {
      return {
        status: 'mfa_required',
        challengeToken: await this.challenge(user, 'verify'),
        methods: ['totp', 'recovery'],
      };
    }
    if (required) {
      return {
        status: 'mfa_enrollment_required',
        challengeToken: await this.challenge(user, 'enroll'),
      };
    }
    return this.issueTokens(user, meta, null);
  }

  /** Must this user have a second factor? */
  private async mfaRequired(client: PoolClient, user: AuthUserRow): Promise<boolean> {
    if (this.config.get<string>('MFA_ENFORCEMENT') === 'optional') return false;
    if (this.requireRole(user) === 'admin') return true;
    const { rows } = await client.query<{ mfa_required_for_all: boolean }>(
      'SELECT mfa_required_for_all FROM clinic_settings WHERE tenant_id = $1',
      [user.tenant_id],
    );
    return rows[0]?.mfa_required_for_all ?? false;
  }

  private challenge(user: AuthUserRow, stage: ChallengeStage): Promise<string> {
    const claims: ChallengeClaims = {
      sub: user.id,
      tenantId: user.tenant_id,
      type: 'mfa_challenge',
      stage,
    };
    return this.jwt.signAsync(claims, {
      secret: this.config.get<string>('JWT_SECRET'),
      expiresIn: CHALLENGE_TTL,
    });
  }

  /** Spend a challenge token: verify it, and re-check the account behind it. */
  private async readChallenge(token: string, stage: ChallengeStage): Promise<AuthUserRow> {
    let claims: ChallengeClaims;
    try {
      claims = await this.jwt.verifyAsync<ChallengeClaims>(token, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException(EXPIRED_CHALLENGE);
    }
    const tenantId = this.tenant.getRequiredTenantId();
    if (claims.type !== 'mfa_challenge' || claims.stage !== stage || claims.tenantId !== tenantId) {
      throw new UnauthorizedException(EXPIRED_CHALLENGE);
    }
    const user = await this.users.findForAuthById(tenantId, claims.sub);
    if (!user) throw new UnauthorizedException(EXPIRED_CHALLENGE);
    this.assertMaySignIn(user);
    return user;
  }

  /** The second step: a TOTP code or a recovery code. */
  async verifyMfa(
    challengeToken: string,
    input: { code?: string; recoveryCode?: string },
    meta: RequestMeta,
  ): Promise<AuthenticatedResult> {
    if (Boolean(input.code) === Boolean(input.recoveryCode)) {
      throw new BadRequestException('Enter the code from your authenticator app, or one recovery code.');
    }
    const user = await this.readChallenge(challengeToken, 'verify');

    const result = await this.db.withTenant(user.tenant_id, async (c) => {
      const verdict = await this.mfa.verify(c, 'clinic', {
        ownerId: user.id,
        code: input.code,
        recoveryCode: input.recoveryCode,
        nowMs: Date.now(),
      });
      if (verdict.ok && verdict.method === 'recovery') {
        await this.audit.record(c, this.actorFor(user), {
          action: 'auth.recovery_code_used',
          entityType: 'user',
          entityId: user.id,
          summary: `${user.full_name} signed in with a recovery code (${verdict.recoveryCodesRemaining} left)`,
          metadata: { remaining: verdict.recoveryCodesRemaining },
        });
      }
      return verdict;
    });

    // Thrown only now, after the transaction that counted the failure has
    // committed. See MfaService.verify.
    if (!result.ok) throw new UnauthorizedException(mfaFailureMessage(result.reason));
    return this.issueTokens(user, meta, new Date());
  }

  /** Enrollment during sign-in, for someone who must have MFA and does not yet. */
  async beginEnrollment(challengeToken: string) {
    const user = await this.readChallenge(challengeToken, 'enroll');
    return this.db.withTenant(user.tenant_id, (c) =>
      this.mfa.beginTotp(c, 'clinic', {
        tenantId: user.tenant_id,
        ownerId: user.id,
        account: user.email,
        issuer: `DentalCare (${user.clinic_name})`,
      }),
    );
  }

  async confirmEnrollment(
    challengeToken: string,
    code: string,
    meta: RequestMeta,
  ): Promise<AuthenticatedResult & { recoveryCodes: string[] }> {
    const user = await this.readChallenge(challengeToken, 'enroll');
    const { recoveryCodes } = await this.db.withTenant(user.tenant_id, async (c) => {
      const confirmed = await this.mfa.confirmTotp(c, 'clinic', {
        tenantId: user.tenant_id,
        ownerId: user.id,
        code,
        nowMs: Date.now(),
      });
      await this.audit.record(c, this.actorFor(user), {
        action: 'auth.mfa_enrolled',
        entityType: 'user',
        entityId: user.id,
        summary: `${user.full_name} set up two-step sign-in`,
      });
      return confirmed;
    });
    const tokens = await this.issueTokens(user, meta, new Date());
    return { ...tokens, recoveryCodes };
  }

  /* ─────────────────────────── sessions ─────────────────────────── */

  async refresh(refreshToken: string, meta: RequestMeta) {
    const tenantId = this.tenant.getRequiredTenantId();
    const result = await this.db.withTenant(tenantId, (c) =>
      rotateSession(c, 'user_sessions', refreshToken, {
        tenantId,
        userAgent: meta.userAgent,
        ip: meta.ip,
        ownerIsActive: async (ownerId) => {
          const user = await this.users.findForAuthById(tenantId, ownerId);
          return (
            Boolean(user) &&
            user!.user_status === 'active' &&
            user!.tenant_status === 'active' &&
            normalizeRole(user!.role) !== null
          );
        },
      }),
    );

    // Thrown after the transaction: a replayed token has just revoked its
    // whole session, and that must stay revoked.
    if (!result.ok) {
      throw new UnauthorizedException(
        result.reason === 'reused'
          ? 'This session was ended because its sign-in token was used twice. Please sign in again.'
          : result.reason === 'owner_inactive'
            ? 'Account no longer active'
            : 'Invalid refresh token',
      );
    }

    const user = await this.users.findForAuthById(tenantId, result.ownerId);
    if (!user) throw new UnauthorizedException('Account no longer active');
    return {
      accessToken: await this.signAccess(user, result.next.sessionId),
      refreshToken: result.next.refreshToken,
    };
  }

  /** Always succeeds: logging out with a bad token reveals nothing about it. */
  async logout(refreshToken: string): Promise<{ signedOut: true }> {
    const tenantId = this.tenant.getRequiredTenantId();
    await this.db.withTenant(tenantId, (c) =>
      revokeByToken(c, 'user_sessions', refreshToken, 'logout'),
    );
    return { signedOut: true };
  }

  async listSessions(current: AccessTokenPayload) {
    return this.db.withTenant(current.tenantId, async (c) => {
      const currentFamily = await familyOf(c, 'user_sessions', current.sid, current.sub);
      const sessions = await listActive(c, 'user_sessions', current.sub);
      return sessions.map((s) => ({ ...s, current: s.familyId === currentFamily }));
    });
  }

  async revokeSession(current: AccessTokenPayload, familyId: string) {
    return this.db.withTenant(current.tenantId, async (c) => {
      const { rowCount } = await c.query(
        'SELECT 1 FROM user_sessions WHERE family_id = $1 AND user_id = $2 LIMIT 1',
        [familyId, current.sub],
      );
      if (!rowCount) throw new NotFoundException('Session not found');
      await revokeFamily(c, 'user_sessions', familyId, 'revoked_by_user');
      return { revoked: true as const };
    });
  }

  async revokeOtherSessions(current: AccessTokenPayload) {
    return this.db.withTenant(current.tenantId, async (c) => {
      const keep = await familyOf(c, 'user_sessions', current.sid, current.sub);
      const revoked = await revokeAllFor(c, 'user_sessions', current.sub, 'revoked_by_user', keep);
      return { revoked };
    });
  }

  /* ─────────────────────── account security ─────────────────────── */

  /**
   * Change the caller's own password. Re-verifies the current password so a
   * hijacked session cannot lock the real owner out of their account, and
   * ends every OTHER session — the point of changing a password is usually
   * that someone else has it.
   */
  async changePassword(
    current: AccessTokenPayload,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ changed: true }> {
    const tenantId = this.tenant.getRequiredTenantId();
    const user = await this.users.findForAuthById(tenantId, current.sub);
    if (!user || user.user_status !== 'active') {
      throw new UnauthorizedException();
    }

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    if (await bcrypt.compare(newPassword, user.password_hash)) {
      throw new BadRequestException('New password must be different');
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.db.withTenant(tenantId, async (c) => {
      await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
        user.id,
        hash,
      ]);
      const keep = await familyOf(c, 'user_sessions', current.sid, user.id);
      await revokeAllFor(c, 'user_sessions', user.id, 'password_changed', keep);
    });
    return { changed: true };
  }

  async mfaStatus(current: AccessTokenPayload) {
    const user = await this.currentUser(current);
    return this.db.withTenant(user.tenant_id, async (c) => ({
      ...(await this.mfa.status(c, 'clinic', user.id)),
      required: await this.mfaRequired(c, user),
    }));
  }

  /** Enrollment from account settings, for someone already signed in. */
  async setupTotp(current: AccessTokenPayload) {
    const user = await this.currentUser(current);
    return this.db.withTenant(user.tenant_id, (c) =>
      this.mfa.beginTotp(c, 'clinic', {
        tenantId: user.tenant_id,
        ownerId: user.id,
        account: user.email,
        issuer: `DentalCare (${user.clinic_name})`,
      }),
    );
  }

  /**
   * Finish enrollment from settings. Other sessions were opened without the
   * factor that now protects this account, so they end.
   */
  async confirmTotp(current: AccessTokenPayload, code: string) {
    const user = await this.currentUser(current);
    return this.db.withTenant(user.tenant_id, async (c) => {
      const result = await this.mfa.confirmTotp(c, 'clinic', {
        tenantId: user.tenant_id,
        ownerId: user.id,
        code,
        nowMs: Date.now(),
      });
      const keep = await familyOf(c, 'user_sessions', current.sid, user.id);
      await revokeAllFor(c, 'user_sessions', user.id, 'mfa_changed', keep);
      await this.audit.record(c, this.actorFor(user), {
        action: 'auth.mfa_enrolled',
        entityType: 'user',
        entityId: user.id,
        summary: `${user.full_name} set up two-step sign-in`,
      });
      return result;
    });
  }

  /** New recovery codes, proven with a current authenticator code. */
  async regenerateRecoveryCodes(current: AccessTokenPayload, code: string) {
    const user = await this.currentUser(current);
    const outcome = await this.db.withTenant(user.tenant_id, async (c) => {
      const verdict = await this.mfa.verify(c, 'clinic', {
        ownerId: user.id,
        code,
        nowMs: Date.now(),
      });
      if (!verdict.ok) return { ok: false as const, reason: verdict.reason };
      const recoveryCodes = await this.mfa.replaceRecoveryCodes(c, 'clinic', {
        tenantId: user.tenant_id,
        ownerId: user.id,
      });
      await this.audit.record(c, this.actorFor(user), {
        action: 'auth.recovery_codes_regenerated',
        entityType: 'user',
        entityId: user.id,
        summary: `${user.full_name} generated new recovery codes`,
      });
      return { ok: true as const, recoveryCodes };
    });
    if (!outcome.ok) throw new UnauthorizedException(mfaFailureMessage(outcome.reason));
    return { recoveryCodes: outcome.recoveryCodes };
  }

  /**
   * Turn two-step sign-in off. Needs the password AND a current code, and is
   * refused outright where MFA is required — an administrator cannot opt out
   * of the floor, only have an administrator reset it for a lost device.
   */
  async disableMfa(current: AccessTokenPayload, password: string, code: string) {
    const user = await this.currentUser(current);
    if (!(await bcrypt.compare(password, user.password_hash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const outcome = await this.db.withTenant(user.tenant_id, async (c) => {
      if (await this.mfaRequired(c, user)) return { ok: false as const, required: true as const };
      const verdict = await this.mfa.verify(c, 'clinic', {
        ownerId: user.id,
        code,
        nowMs: Date.now(),
      });
      if (!verdict.ok) return { ok: false as const, reason: verdict.reason };
      await this.mfa.disable(c, 'clinic', user.id);
      const keep = await familyOf(c, 'user_sessions', current.sid, user.id);
      await revokeAllFor(c, 'user_sessions', user.id, 'mfa_changed', keep);
      await this.audit.record(c, this.actorFor(user), {
        action: 'auth.mfa_disabled',
        entityType: 'user',
        entityId: user.id,
        summary: `${user.full_name} turned off two-step sign-in`,
      });
      return { ok: true as const };
    });

    if (!outcome.ok) {
      if ('required' in outcome) {
        throw new ForbiddenException('Two-step sign-in is required for your role at this clinic.');
      }
      throw new UnauthorizedException(mfaFailureMessage(outcome.reason));
    }
    return { disabled: true as const };
  }

  /** /auth/me, with the MFA state the SPA needs to prompt enrollment. */
  async me(current: AccessTokenPayload) {
    const user = await this.currentUser(current);
    const role = this.requireRole(user);
    const ctx = this.tenant.get();
    const { mfa, currency, timezone } = await this.db.withTenant(user.tenant_id, async (c) => ({
      mfa: {
        enrolled: (await this.mfa.status(c, 'clinic', user.id)).enrolled,
        required: await this.mfaRequired(c, user),
      },
      currency: await clinicCurrency(c),
      // Appointment times are the clinic's wall clock, whatever zone the
      // browser happens to be in. The SPA shows and books in this zone.
      timezone:
        (await c.query<{ timezone: string }>('SELECT timezone FROM clinic_settings LIMIT 1')).rows[0]?.timezone ??
        'Europe/Tirane',
    }));
    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role,
      tenantId: user.tenant_id,
      clinicName: user.clinic_name,
      permissions: permissionsFor(role),
      // Advisory only — ReadOnlyGuard is what actually refuses the write.
      trial: {
        endsAt: ctx?.trialEndsAt ?? null,
        readOnly: ctx?.readOnly ?? false,
      },
      mfa,
      /** Every amount this clinic's API returns is minor units of this currency. */
      currency,
      /** The clinic's IANA time zone: appointments are shown and booked in it. */
      timezone,
    };
  }

  /* ─────────────────────────── internals ─────────────────────────── */

  private async currentUser(current: AccessTokenPayload): Promise<AuthUserRow> {
    const user = await this.users.findForAuthById(this.tenant.getRequiredTenantId(), current.sub);
    if (!user || user.user_status !== 'active') throw new UnauthorizedException();
    return user;
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

  private actorFor(user: AuthUserRow): ClinicAuditActor {
    return { userId: user.id, label: user.email, role: this.requireRole(user) };
  }

  private async issueTokens(
    user: AuthUserRow,
    meta: RequestMeta,
    mfaVerifiedAt: Date | null,
  ): Promise<AuthenticatedResult> {
    const role = this.requireRole(user);
    const lifetime = durationMs(this.config.get<string>('JWT_REFRESH_TTL') ?? '7d');
    const session = await this.db.withTenant(user.tenant_id, (c) =>
      createSession(c, 'user_sessions', {
        tenantId: user.tenant_id,
        ownerId: user.id,
        expiresAt: new Date(Date.now() + lifetime),
        mfaVerifiedAt,
        userAgent: meta.userAgent,
        ip: meta.ip,
      }),
    );

    return {
      status: 'authenticated',
      accessToken: await this.signAccess(user, session.sessionId),
      refreshToken: session.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role,
        tenantId: user.tenant_id,
        clinicName: user.clinic_name,
        permissions: permissionsFor(role),
      },
    };
  }

  private signAccess(user: AuthUserRow, sessionId: string) {
    const payload: AccessTokenPayload = {
      sub: user.id,
      tenantId: user.tenant_id,
      role: this.requireRole(user),
      email: user.email,
      sid: sessionId,
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.get<string>('JWT_SECRET'),
      // @nestjs/jwt 11 types expiresIn with ms's template-literal StringValue
      // ("15m", "7d"), which a string read from the environment cannot prove
      // it is. The cast restores the Nest 10 contract rather than weakening
      // it: env.validation rejects an empty TTL at boot, and jsonwebtoken
      // still throws at sign time on a value that is not a timespan.
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL') as JwtSignOptions['expiresIn'],
    });
  }
}
