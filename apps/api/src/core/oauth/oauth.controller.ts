import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { AuthService } from '@/modules/clinic/auth';
import { UsersService } from '@/modules/clinic/users';
import { PlatformAuthService } from '@/modules/platform/auth';
import { GoogleIdentity } from './google.strategy';
import { normalizeRole } from '@dentalcare/shared';
import { decideGoogleLink } from './link-account';
import type { OAuthState } from './oauth-state';
import { ClinicGoogleGuard } from './clinic-google.guard';
import { GoogleCallbackGuard } from './google-callback.guard';
import { GoogleOAuthService, type RequestWithOAuth } from './google-oauth.service';
import { PlatformGoogleGuard } from './platform-google.guard';

/**
 * Google sign-in for both planes.
 *
 * ── Why this controller lives in core/ and reaches into both planes ───────
 *
 * Google allows one exact redirect URI per client. Clinics are on wildcard
 * subdomains and the console is on its own host, so a per-plane callback would
 * need a per-plane Google client — two sets of credentials to rotate for one
 * feature. Instead there is a single callback that reads the plane out of the
 * signed state and hands off to whichever auth service owns it.
 *
 * That makes this file the one place `core/` depends on `tenant/` and
 * `platform/`. It is a composition root, not a layering accident, and it is
 * the only file in core/ that does it.
 *
 * ── Why these routes are outside the tenant middleware ────────────────────
 *
 * The callback arrives on the API host, which has no clinic subdomain to
 * resolve. The middleware would 404 it before the handler ran. The clinic is
 * carried in the state instead and resolved here.
 */

/** The outcome of a sign-in attempt, once Google has done its part. */
type SignInOutcome =
  { ok: true; tokens: Record<string, unknown> } | { ok: false; reason: string };

/** Kept on the session the sign-in creates. */
interface SignInMeta {
  userAgent: string | null;
  ip: string | null;
}

@Controller()
export class OAuthController {
  constructor(
    private readonly oauth: GoogleOAuthService,
    private readonly db: DatabaseService,
    private readonly tenantCtx: TenantContextService,
    private readonly audit: ClinicAuditService,
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly platformAuth: PlatformAuthService,
  ) {}

  /**
   * Lets each login screen decide whether to draw the Google button, instead
   * of drawing one that fails on a deployment without credentials.
   */
  @Get('auth/providers')
  providers() {
    return { google: this.oauth.enabled };
  }

  /** Clinic sign-in. `?clinic=` names the practice; the guard signs it in. */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Get('auth/google')
  @UseGuards(ClinicGoogleGuard)
  startClinic(): void {
    /* the guard redirects to Google */
  }

  /** Console sign-in. One host, so no clinic to name. */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Get('platform/auth/google')
  @UseGuards(PlatformGoogleGuard)
  startPlatform(): void {
    /* the guard redirects to Google */
  }

  @Get('auth/google/callback')
  @UseGuards(GoogleCallbackGuard)
  async callback(@Req() req: RequestWithOAuth, @Res() res: Response): Promise<void> {
    const identity = req.user as GoogleIdentity | undefined;
    // Verified by GoogleCallbackGuard before passport exchanged the code; an
    // unverified state never reaches this handler at all.
    const state = req.oauthState!;

    if (!identity) {
      this.fail(res, state, 'Google did not complete the sign-in.');
      return;
    }

    const meta = { userAgent: req.headers['user-agent'] ?? null, ip: req.ip ?? null };

    try {
      const result =
        state.plane === 'platform'
          ? await this.platformSignIn(identity, meta)
          : await this.clinicSignIn(state, identity, meta);

      if (!result.ok) {
        this.fail(res, state, result.reason);
        return;
      }
      this.succeed(res, state, result.tokens);
    } catch {
      // Never leak an internal error into a URL the user will see.
      this.fail(res, state, 'Sign-in failed. Please try again.');
    }
  }

  /* ────────────────────────── clinic ────────────────────────── */

  private async clinicSignIn(
    state: OAuthState,
    identity: GoogleIdentity,
    meta: SignInMeta,
  ): Promise<SignInOutcome> {
    const { rows } = await this.db.query<{ id: string; status: string }>(
      'SELECT id, status FROM resolve_tenant($1)',
      [state.tenant],
    );
    const tenant = rows[0];
    if (!tenant) return { ok: false, reason: 'That clinic could not be found.' };
    if (tenant.status !== 'active') {
      return { ok: false, reason: "This clinic's access is currently suspended." };
    }

    const user = await this.users.findForAuthByEmail(tenant.id, identity.email);
    const decision = decideGoogleLink(
      user && {
        id: user.id,
        status: user.user_status,
        google_sub: user.google_sub,
      },
      identity,
    );
    if (!decision.allow) return { ok: false, reason: decision.reason };

    if (decision.link) {
      await this.recordClinicLink(tenant.id, state.tenant!, decision.userId, identity);
    }

    // Google proves the first factor only. The same second-factor decision as
    // a password sign-in applies, so this may come back as a challenge.
    const tokens = await this.auth.issueSessionForUser(tenant.id, decision.userId, meta);
    return { ok: true, tokens: { ...tokens } };
  }

  /**
   * The link and its audit entry commit together.
   *
   * `google_sub IS NULL` in the WHERE clause makes the write idempotent: two
   * callbacks racing on a double-clicked button link once and audit once, and
   * the loser signs in anyway on the next line.
   */
  private async recordClinicLink(
    tenantId: string,
    subdomain: string,
    userId: string,
    identity: GoogleIdentity,
  ): Promise<void> {
    await this.tenantCtx.run(
      { id: tenantId, subdomain, status: 'active', trialEndsAt: null, readOnly: false },
      async () =>
        this.db.withTenant(tenantId, async (client) => {
          const res = await client.query<{ full_name: string; role: string }>(
            `UPDATE users
                SET google_sub = $2, google_linked_at = now(), updated_at = now()
              WHERE id = $1 AND google_sub IS NULL
              RETURNING full_name, role`,
            [userId, identity.sub],
          );
          if (!res.rowCount) return; // already linked by a parallel callback

          // The trail records the role held at the time, like every other
          // entry — not a placeholder that would misattribute the action.
          const role = normalizeRole(res.rows[0]!.role);
          if (!role) return;

          await this.audit.record(
            client,
            { userId, label: identity.email, role },
            {
              action: 'staff.updated',
              entityType: 'user',
              entityId: userId,
              summary: `${res.rows[0]!.full_name} linked a Google account for sign-in`,
              metadata: { googleEmail: identity.email, viaGoogle: true },
            },
          );
        }),
    );
  }

  /* ───────────────────────── platform ───────────────────────── */

  private async platformSignIn(
    identity: GoogleIdentity,
    meta: SignInMeta,
  ): Promise<SignInOutcome> {
    const admin = await this.platformAuth.findForOAuth(identity.email);
    const decision = decideGoogleLink(
      admin && {
        id: admin.id,
        status: admin.status as 'active' | 'disabled',
        google_sub: admin.google_sub,
      },
      identity,
    );
    if (!decision.allow) return { ok: false, reason: decision.reason };

    if (decision.link) await this.platformAuth.linkGoogle(decision.userId, identity.sub);
    return {
      ok: true,
      tokens: { ...(await this.platformAuth.issueForAdmin(decision.userId, meta)) },
    };
  }

  /* ───────────────────────── redirects ──────────────────────── */

  /**
   * Hand the session back in the URL FRAGMENT, never the query string.
   *
   * A fragment is not sent to the server, so the token stays out of access
   * logs, out of the Referer header on the next navigation, and out of any
   * proxy in between. The SPA reads it and clears it immediately.
   *
   * When the account needs a second factor there is no session yet: the
   * fragment carries the challenge token instead, and the SPA continues the
   * sign-in at its MFA step exactly as it would after a password.
   */
  private succeed(
    res: Response,
    state: OAuthState,
    tokens: Record<string, unknown>,
  ): void {
    const origin = this.oauth.appOrigin(state.plane, state.tenant);
    if (!origin) {
      // Unconfigured base URL — local development. Return the payload so the
      // flow stays testable rather than redirecting nowhere.
      res.json(tokens);
      return;
    }
    const next = state.next ?? '/';
    const params =
      tokens.status === 'mfa_required' || tokens.status === 'mfa_enrollment_required'
        ? new URLSearchParams({
            mfa: String(tokens.challengeToken ?? ''),
            stage: tokens.status === 'mfa_required' ? 'verify' : 'enroll',
            next,
          })
        : new URLSearchParams({ access: String(tokens.accessToken ?? ''), next });
    if (tokens.status === 'authenticated' && tokens.refreshToken) {
      params.set('refresh', String(tokens.refreshToken));
    }
    res.redirect(`${origin}/auth/callback#${params.toString()}`);
  }

  private fail(res: Response, state: OAuthState, reason: string): void {
    const origin = this.oauth.appOrigin(state.plane, state.tenant);
    if (!origin) {
      res.status(401).json({ code: 'oauth_denied', message: reason });
      return;
    }
    res.redirect(`${origin}/login?error=${encodeURIComponent(reason)}`);
  }
}
