import { PoolClient } from 'pg';
import {
  formatRefreshToken,
  hashSecret,
  newRefreshSecret,
  parseRefreshToken,
  reuseVerdict,
  secretMatches,
} from './session-tokens';

/**
 * Server-side sessions for both planes (migration 0005).
 *
 * One implementation, two tables: `user_sessions` for clinic staff (under
 * RLS, so the caller's transaction must already carry the tenant) and
 * `platform_sessions` for the console (the privileged connection). Everything
 * here takes a client, so it runs inside whichever transaction the plane
 * opened — and nothing here throws on a bad token. It returns a verdict,
 * because a replayed token must REVOKE the session and that revocation has to
 * commit; throwing a 401 from inside the transaction would roll it back and
 * leave the thief's token working.
 *
 * ── Families ──────────────────────────────────────────────────────────────
 *
 * A sign-in starts a family. Every refresh adds a row to it and marks the
 * previous row as rotated. Revocation — logout, password change, a replayed
 * token — revokes the family, which kills every token descended from that
 * sign-in at once. The family's absolute expiry is fixed at sign-in: refreshing
 * extends nothing, so a session cannot be kept alive forever by a script.
 */

export type SessionTable = 'user_sessions' | 'platform_sessions';

const OWNER_COLUMN: Readonly<Record<SessionTable, string>> = {
  user_sessions: 'user_id',
  platform_sessions: 'admin_id',
};

export interface NewSession {
  sessionId: string;
  familyId: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface SessionContext {
  /** Required for user_sessions; ignored for platform_sessions. */
  tenantId?: string;
  userAgent?: string | null;
  ip?: string | null;
}

export type RevocationReason =
  | 'logout'
  | 'refresh_token_reuse'
  | 'owner_inactive'
  | 'password_changed'
  | 'password_reset'
  | 'account_disabled'
  | 'role_changed'
  | 'mfa_changed'
  | 'revoked_by_user';

/** Truncated rather than refused: a user agent is evidence, not input. */
const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);

export async function createSession(
  client: PoolClient,
  table: SessionTable,
  opts: SessionContext & {
    ownerId: string;
    expiresAt: Date;
    /** Continue an existing family (a refresh) rather than start one. */
    familyId?: string;
    /** When the sign-in that started this family passed a second factor. */
    mfaVerifiedAt: Date | null;
  },
): Promise<NewSession> {
  const owner = OWNER_COLUMN[table];
  const secret = newRefreshSecret();

  // Housekeeping for this owner only, on the way in: long-expired rows are no
  // use to anyone. Scoped to one owner so a sign-in never scans the table.
  await client.query(
    `DELETE FROM ${table}
      WHERE ${owner} = $1 AND expires_at < now() - interval '1 day'`,
    [opts.ownerId],
  );

  const columns = [
    owner,
    'family_id',
    'token_hash',
    'expires_at',
    'mfa_verified_at',
    'user_agent',
    'ip',
  ];
  const values: unknown[] = [
    opts.ownerId,
    opts.familyId ?? null,
    hashSecret(secret),
    opts.expiresAt,
    opts.mfaVerifiedAt,
    clip(opts.userAgent, 300),
    clip(opts.ip, 64),
  ];
  if (table === 'user_sessions') {
    if (!opts.tenantId) throw new Error('user_sessions requires a tenant');
    columns.unshift('tenant_id');
    values.unshift(opts.tenantId);
  }
  const placeholders = columns.map((c, i) =>
    c === 'family_id' ? `coalesce($${i + 1}::uuid, gen_random_uuid())` : `$${i + 1}`,
  );

  const { rows } = await client.query<{ id: string; family_id: string }>(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING id, family_id`,
    values,
  );
  const row = rows[0]!;
  return {
    sessionId: row.id,
    familyId: row.family_id,
    refreshToken: formatRefreshToken(row.id, secret),
    expiresAt: opts.expiresAt,
  };
}

export type RotationResult =
  | {
      ok: true;
      ownerId: string;
      familyId: string;
      mfaVerifiedAt: Date | null;
      next: NewSession;
    }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'reused' | 'owner_inactive' };

/**
 * Exchange a refresh token for its successor.
 *
 * `ownerIsActive` is asked before anything is issued, so a disabled account or
 * a suspended clinic ends the session here rather than one refresh later.
 */
export async function rotateSession(
  client: PoolClient,
  table: SessionTable,
  token: string,
  opts: SessionContext & { ownerIsActive: (ownerId: string) => Promise<boolean> },
): Promise<RotationResult> {
  const parsed = parseRefreshToken(token);
  if (!parsed) return { ok: false, reason: 'invalid' };

  const owner = OWNER_COLUMN[table];
  const { rows } = await client.query<{
    family_id: string;
    owner_id: string;
    token_hash: string;
    expires_at: Date;
    rotated_at: Date | null;
    revoked_at: Date | null;
    mfa_verified_at: Date | null;
    now: Date;
  }>(
    `SELECT family_id, ${owner} AS owner_id, token_hash, expires_at,
            rotated_at, revoked_at, mfa_verified_at, now() AS now
       FROM ${table}
      WHERE id = $1
      FOR UPDATE`,
    [parsed.sessionId],
  );
  const row = rows[0];
  if (!row || !secretMatches(parsed.secret, row.token_hash)) {
    return { ok: false, reason: 'invalid' };
  }
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.expires_at.getTime() <= row.now.getTime()) return { ok: false, reason: 'expired' };

  const verdict = reuseVerdict(row.rotated_at, row.now);
  if (verdict === 'replayed') {
    await revokeFamily(client, table, row.family_id, 'refresh_token_reuse');
    return { ok: false, reason: 'reused' };
  }

  if (!(await opts.ownerIsActive(row.owner_id))) {
    await revokeFamily(client, table, row.family_id, 'owner_inactive');
    return { ok: false, reason: 'owner_inactive' };
  }

  const next = await createSession(client, table, {
    ...opts,
    ownerId: row.owner_id,
    familyId: row.family_id,
    expiresAt: row.expires_at,
    mfaVerifiedAt: row.mfa_verified_at,
  });

  if (verdict === 'fresh') {
    await client.query(
      `UPDATE ${table} SET rotated_at = now(), last_used_at = now() WHERE id = $1`,
      [parsed.sessionId],
    );
  }

  return {
    ok: true,
    ownerId: row.owner_id,
    familyId: row.family_id,
    mfaVerifiedAt: row.mfa_verified_at,
    next,
  };
}

export async function revokeFamily(
  client: PoolClient,
  table: SessionTable,
  familyId: string,
  reason: RevocationReason,
): Promise<number> {
  const res = await client.query(
    `UPDATE ${table} SET revoked_at = now(), revoked_reason = $2
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason],
  );
  return res.rowCount ?? 0;
}

/** Revoke every session an owner has, optionally sparing the caller's own. */
export async function revokeAllFor(
  client: PoolClient,
  table: SessionTable,
  ownerId: string,
  reason: RevocationReason,
  exceptFamilyId?: string | null,
): Promise<number> {
  const res = await client.query(
    `UPDATE ${table} SET revoked_at = now(), revoked_reason = $2
      WHERE ${OWNER_COLUMN[table]} = $1
        AND revoked_at IS NULL
        AND ($3::uuid IS NULL OR family_id <> $3::uuid)`,
    [ownerId, reason, exceptFamilyId ?? null],
  );
  return res.rowCount ?? 0;
}

/** The family a session row belongs to, if it belongs to this owner. */
export async function familyOf(
  client: PoolClient,
  table: SessionTable,
  sessionId: string | undefined,
  ownerId: string,
): Promise<string | null> {
  if (!sessionId) return null;
  const { rows } = await client.query<{ family_id: string }>(
    `SELECT family_id FROM ${table} WHERE id = $1 AND ${OWNER_COLUMN[table]} = $2`,
    [sessionId, ownerId],
  );
  return rows[0]?.family_id ?? null;
}

/** Revoke the family a refresh token belongs to. Silent on a bad token. */
export async function revokeByToken(
  client: PoolClient,
  table: SessionTable,
  token: string,
  reason: RevocationReason,
): Promise<void> {
  const parsed = parseRefreshToken(token);
  if (!parsed) return;
  const { rows } = await client.query<{ family_id: string; token_hash: string }>(
    `SELECT family_id, token_hash FROM ${table} WHERE id = $1`,
    [parsed.sessionId],
  );
  const row = rows[0];
  if (row && secretMatches(parsed.secret, row.token_hash)) {
    await revokeFamily(client, table, row.family_id, reason);
  }
}

export interface ActiveSession {
  familyId: string;
  startedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  mfaVerified: boolean;
}

/** One entry per signed-in device: the family, not its individual refreshes. */
export async function listActive(
  client: PoolClient,
  table: SessionTable,
  ownerId: string,
): Promise<ActiveSession[]> {
  const { rows } = await client.query<{
    family_id: string;
    started_at: string;
    last_seen_at: string;
    expires_at: string;
    user_agent: string | null;
    ip: string | null;
    mfa_verified: boolean;
  }>(
    `SELECT family_id,
            min(created_at) AS started_at,
            max(coalesce(last_used_at, created_at)) AS last_seen_at,
            max(expires_at) AS expires_at,
            (array_agg(user_agent ORDER BY created_at DESC))[1] AS user_agent,
            (array_agg(ip ORDER BY created_at DESC))[1] AS ip,
            bool_or(mfa_verified_at IS NOT NULL) AS mfa_verified
       FROM ${table}
      WHERE ${OWNER_COLUMN[table]} = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      GROUP BY family_id
      ORDER BY max(coalesce(last_used_at, created_at)) DESC`,
    [ownerId],
  );
  return rows.map((r) => ({
    familyId: r.family_id,
    startedAt: r.started_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    userAgent: r.user_agent,
    ip: r.ip,
    mfaVerified: r.mfa_verified,
  }));
}
