import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { PoolClient } from 'pg';
import { Keyring, developmentKeyring, keyedHash, open, parseKeyring, seal } from './secret-box';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp';
import { generateRecoveryCodes, normalizeRecoveryCode } from './recovery-codes';

/**
 * Second factors for both planes (migration 0005).
 *
 * Like the session store, every method takes the caller's client, so it runs
 * inside whichever plane's transaction is open — RLS-scoped for clinic staff,
 * the privileged connection for the console — and a failed verification
 * RETURNS rather than throws. The failure counter has to commit; a 401 thrown
 * from inside the transaction would roll back the count and give an attacker
 * unlimited guesses.
 *
 * ── Guessing ──────────────────────────────────────────────────────────────
 *
 * A six-digit code is a million possibilities with three valid at any moment.
 * Five wrong codes lock the factor for fifteen minutes, on top of the per-IP
 * throttle on the endpoint; a recovery code counts against the same limit.
 */

export type MfaPlane = 'clinic' | 'platform';

const PLANES = {
  clinic: { factors: 'user_mfa_factors', codes: 'user_mfa_recovery_codes', owner: 'user_id' },
  platform: {
    factors: 'platform_mfa_factors',
    codes: 'platform_mfa_recovery_codes',
    owner: 'admin_id',
  },
} as const;

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export interface MfaStatus {
  enrolled: boolean;
  confirmedAt: string | null;
  lockedUntil: string | null;
  recoveryCodesRemaining: number;
}

export type MfaVerification =
  | { ok: true; method: 'totp' | 'recovery'; recoveryCodesRemaining: number }
  | { ok: false; reason: 'not_enrolled' | 'invalid' | 'locked' };

interface Owner {
  ownerId: string;
  /** Required on the clinic plane, where every row carries its tenant. */
  tenantId?: string;
}

@Injectable()
export class MfaService {
  private readonly keyring: Keyring;

  constructor(config: ConfigService) {
    const spec = config.get<string>('MFA_ENCRYPTION_KEYS');
    // env.validation refuses production without keys, so the derived key can
    // only ever be reached in development and tests.
    this.keyring = spec
      ? parseKeyring(spec)
      : developmentKeyring(config.get<string>('JWT_SECRET')!);
  }

  /** Binds a ciphertext to its table and owner. See secret-box.ts. */
  private aad(plane: MfaPlane, ownerId: string) {
    return `${PLANES[plane].factors}:${ownerId}`;
  }

  private tenantColumns(plane: MfaPlane, owner: Owner, columns: string[], values: unknown[]) {
    if (plane !== 'clinic') return;
    if (!owner.tenantId) throw new Error('clinic MFA rows require a tenant');
    columns.unshift('tenant_id');
    values.unshift(owner.tenantId);
  }

  async status(client: PoolClient, plane: MfaPlane, ownerId: string): Promise<MfaStatus> {
    const p = PLANES[plane];
    const { rows } = await client.query<{ confirmed_at: Date; locked_until: Date | null }>(
      `SELECT confirmed_at, locked_until FROM ${p.factors}
        WHERE ${p.owner} = $1 AND disabled_at IS NULL AND confirmed_at IS NOT NULL`,
      [ownerId],
    );
    const factor = rows[0];
    return {
      enrolled: Boolean(factor),
      confirmedAt: factor ? factor.confirmed_at.toISOString() : null,
      lockedUntil:
        factor?.locked_until && factor.locked_until.getTime() > Date.now()
          ? factor.locked_until.toISOString()
          : null,
      recoveryCodesRemaining: factor ? await this.remainingCodes(client, plane, ownerId) : 0,
    };
  }

  private async remainingCodes(client: PoolClient, plane: MfaPlane, ownerId: string) {
    const p = PLANES[plane];
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${p.codes}
        WHERE ${p.owner} = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [ownerId],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * Start, or restart, TOTP enrollment. The secret is returned exactly once,
   * to be shown as a QR code; afterwards only its ciphertext exists.
   */
  async beginTotp(
    client: PoolClient,
    plane: MfaPlane,
    owner: Owner & { account: string; issuer: string },
  ): Promise<{ secret: string; otpauthUri: string }> {
    const p = PLANES[plane];
    const { rowCount } = await client.query(
      `SELECT 1 FROM ${p.factors}
        WHERE ${p.owner} = $1 AND disabled_at IS NULL AND confirmed_at IS NOT NULL`,
      [owner.ownerId],
    );
    if (rowCount) {
      throw new ConflictException(
        'Two-step sign-in is already set up. Turn it off before enrolling a new device.',
      );
    }

    // An abandoned setup is retired, not deleted: the unique index allows one
    // live factor per kind, and the runtime role holds no DELETE.
    await client.query(
      `UPDATE ${p.factors} SET disabled_at = now()
        WHERE ${p.owner} = $1 AND disabled_at IS NULL`,
      [owner.ownerId],
    );

    const secret = generateTotpSecret();
    const sealed = seal(this.keyring, secret, this.aad(plane, owner.ownerId));
    const columns = [p.owner, 'kind', 'secret_ciphertext', 'key_id'];
    const values: unknown[] = [owner.ownerId, 'totp', sealed.ciphertext, sealed.keyId];
    this.tenantColumns(plane, owner, columns, values);
    await client.query(
      `INSERT INTO ${p.factors} (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      values,
    );

    return {
      secret,
      otpauthUri: otpauthUri({ secret, account: owner.account, issuer: owner.issuer }),
    };
  }

  /** Confirm enrollment with a first code. Issues the recovery codes. */
  async confirmTotp(
    client: PoolClient,
    plane: MfaPlane,
    owner: Owner & { code: string; nowMs: number },
  ): Promise<{ recoveryCodes: string[] }> {
    const p = PLANES[plane];
    const { rows } = await client.query<{ id: string; secret_ciphertext: string; key_id: string }>(
      `SELECT id, secret_ciphertext, key_id FROM ${p.factors}
        WHERE ${p.owner} = $1 AND disabled_at IS NULL AND confirmed_at IS NULL
        FOR UPDATE`,
      [owner.ownerId],
    );
    const factor = rows[0];
    if (!factor) {
      throw new BadRequestException('Start setting up two-step sign-in first.');
    }

    const secret = open(
      this.keyring,
      { ciphertext: factor.secret_ciphertext, keyId: factor.key_id },
      this.aad(plane, owner.ownerId),
    );
    const step = verifyTotp(secret, owner.code, { nowMs: owner.nowMs });
    if (step === null) {
      throw new BadRequestException(
        'That code did not match. Make sure your phone sets its clock automatically, then enter the newest code.',
      );
    }

    await client.query(
      `UPDATE ${p.factors} SET confirmed_at = now(), last_used_step = $2 WHERE id = $1`,
      [factor.id, step],
    );
    return { recoveryCodes: await this.replaceRecoveryCodes(client, plane, owner) };
  }

  /** Revoke any unused codes and issue ten new ones, shown once. */
  async replaceRecoveryCodes(client: PoolClient, plane: MfaPlane, owner: Owner): Promise<string[]> {
    const p = PLANES[plane];
    await client.query(
      `UPDATE ${p.codes} SET revoked_at = now()
        WHERE ${p.owner} = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [owner.ownerId],
    );

    const codes = generateRecoveryCodes();
    const keyId = this.keyring.currentId;
    const hashes = codes.map((c) => keyedHash(this.keyring, keyId, normalizeRecoveryCode(c)!));

    const columns = [p.owner, 'key_id'];
    const values: unknown[] = [owner.ownerId, keyId];
    this.tenantColumns(plane, owner, columns, values);
    await client.query(
      `INSERT INTO ${p.codes} (${columns.join(', ')}, code_hash)
       SELECT ${columns.map((_, i) => `$${i + 1}`).join(', ')}, h
         FROM unnest($${columns.length + 1}::text[]) AS h`,
      [...values, hashes],
    );
    return codes;
  }

  /**
   * Check a sign-in's second factor: a TOTP code, or one recovery code.
   *
   * Everything this writes — the spent code, the replay step, the failure
   * count, the lock — must commit whatever the outcome, which is why it
   * returns a verdict instead of throwing.
   */
  async verify(
    client: PoolClient,
    plane: MfaPlane,
    opts: { ownerId: string; code?: string; recoveryCode?: string; nowMs: number },
  ): Promise<MfaVerification> {
    const p = PLANES[plane];
    const { rows } = await client.query<{
      id: string;
      secret_ciphertext: string;
      key_id: string;
      last_used_step: string | null;
      failed_attempts: number;
      locked_until: Date | null;
      now: Date;
    }>(
      `SELECT id, secret_ciphertext, key_id, last_used_step, failed_attempts,
              locked_until, now() AS now
         FROM ${p.factors}
        WHERE ${p.owner} = $1 AND disabled_at IS NULL AND confirmed_at IS NOT NULL
        FOR UPDATE`,
      [opts.ownerId],
    );
    const factor = rows[0];
    if (!factor) return { ok: false, reason: 'not_enrolled' };
    if (factor.locked_until && factor.locked_until.getTime() > factor.now.getTime()) {
      return { ok: false, reason: 'locked' };
    }

    let method: 'totp' | 'recovery' | null = null;

    if (opts.recoveryCode) {
      const normalized = normalizeRecoveryCode(opts.recoveryCode);
      if (normalized) {
        const { rows: codes } = await client.query<{
          id: string;
          code_hash: string;
          key_id: string;
        }>(
          `SELECT id, code_hash, key_id FROM ${p.codes}
            WHERE ${p.owner} = $1 AND used_at IS NULL AND revoked_at IS NULL
            FOR UPDATE`,
          [opts.ownerId],
        );
        let matched: string | null = null;
        for (const c of codes) {
          if (!this.keyring.keys.has(c.key_id)) continue;
          const stored = Buffer.from(c.code_hash, 'hex');
          const presented = Buffer.from(keyedHash(this.keyring, c.key_id, normalized), 'hex');
          if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
            matched = c.id;
          }
        }
        if (matched) {
          await client.query(`UPDATE ${p.codes} SET used_at = now() WHERE id = $1`, [matched]);
          method = 'recovery';
        }
      }
    } else if (opts.code) {
      const secret = open(
        this.keyring,
        { ciphertext: factor.secret_ciphertext, keyId: factor.key_id },
        this.aad(plane, opts.ownerId),
      );
      const step = verifyTotp(secret, opts.code, {
        nowMs: opts.nowMs,
        lastUsedStep: factor.last_used_step === null ? null : Number(factor.last_used_step),
      });
      if (step !== null) {
        await client.query(`UPDATE ${p.factors} SET last_used_step = $2 WHERE id = $1`, [
          factor.id,
          step,
        ]);
        method = 'totp';
      }
    }

    if (method) {
      await client.query(
        `UPDATE ${p.factors} SET failed_attempts = 0, locked_until = NULL WHERE id = $1`,
        [factor.id],
      );
      return {
        ok: true,
        method,
        recoveryCodesRemaining: await this.remainingCodes(client, plane, opts.ownerId),
      };
    }

    const attempts = factor.failed_attempts + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      await client.query(
        `UPDATE ${p.factors}
            SET failed_attempts = 0,
                locked_until = now() + make_interval(mins => $2)
          WHERE id = $1`,
        [factor.id, LOCKOUT_MINUTES],
      );
      return { ok: false, reason: 'locked' };
    }
    await client.query(`UPDATE ${p.factors} SET failed_attempts = $2 WHERE id = $1`, [
      factor.id,
      attempts,
    ]);
    return { ok: false, reason: 'invalid' };
  }

  /** Turn a factor off and void its recovery codes. True if one was live. */
  async disable(client: PoolClient, plane: MfaPlane, ownerId: string): Promise<boolean> {
    const p = PLANES[plane];
    const res = await client.query(
      `UPDATE ${p.factors} SET disabled_at = now()
        WHERE ${p.owner} = $1 AND disabled_at IS NULL`,
      [ownerId],
    );
    await client.query(
      `UPDATE ${p.codes} SET revoked_at = now()
        WHERE ${p.owner} = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [ownerId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

/** The words a person should see for a failed verification. */
export function mfaFailureMessage(reason: 'not_enrolled' | 'invalid' | 'locked'): string {
  switch (reason) {
    case 'locked':
      return `Too many incorrect codes. Wait ${LOCKOUT_MINUTES} minutes and try again.`;
    case 'not_enrolled':
      return 'Two-step sign-in is not set up for this account.';
    default:
      return 'That code is not valid. Enter the newest code from your authenticator app, or an unused recovery code.';
  }
}
