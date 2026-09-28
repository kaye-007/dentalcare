import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import type { CurrencyCode, DrawerEventType } from '@dentalcare/shared';
import type { RequestCtx } from '@/core/request-context/request-context';

/**
 * The drawer's event log: numbered without gaps, and chained.
 *
 * Every event stores the hash of the one before it and its own hash over
 * what happened — who, when, how much, of what, against which payment. The
 * session row keeps the head of the chain. Rows cannot be updated or deleted
 * by the runtime role (0014), and if somebody with the owner's password does
 * it anyway, `verifyChain` finds the first sequence number that no longer
 * adds up.
 *
 * The request's IP and user agent are stored beside each event but are not
 * part of the hash: they describe the request, not the movement of cash.
 */

export const GENESIS_HASH = '0'.repeat(64);

export interface EventFacts {
  sessionId: string;
  seq: number;
  type: DrawerEventType;
  currency: CurrencyCode;
  amount: number;
  paymentId: string | null;
  fiscalCashDepositId: string | null;
  approvalId: string | null;
  reason: string | null;
  actorUserId: string;
  /** ISO 8601 with milliseconds, exactly as stored. */
  occurredAt: string;
}

/**
 * The hash of one event. The payload is a JSON array in a fixed order, so
 * neither key order nor a new optional field can change an old event's hash.
 */
export function eventHash(prevHash: string, e: EventFacts): string {
  const payload = JSON.stringify([
    prevHash,
    e.sessionId,
    e.seq,
    e.type,
    e.currency,
    e.amount,
    e.paymentId,
    e.fiscalCashDepositId,
    e.approvalId,
    e.reason,
    e.actorUserId,
    e.occurredAt,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

export interface StoredEvent extends EventFacts {
  prevHash: string;
  hash: string;
}

/**
 * Walk a session's events in order. Valid only when every sequence number is
 * present, every event links to the one before, every hash recomputes, and
 * the last hash is the head the session row holds.
 */
export function verifyChain(
  events: readonly StoredEvent[],
  head: { lastSeq: number; lastHash: string },
): { valid: true } | { valid: false; brokenAtSeq: number } {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq !== i + 1 || e.prevHash !== prev || eventHash(prev, e) !== e.hash) {
      return { valid: false, brokenAtSeq: i + 1 };
    }
    prev = e.hash;
  }
  if (events.length !== head.lastSeq || prev !== head.lastHash) {
    return { valid: false, brokenAtSeq: events.length + 1 };
  }
  return { valid: true };
}

export interface AppendInput {
  type: DrawerEventType;
  currency: CurrencyCode;
  amount: number;
  paymentId?: string | null;
  fiscalCashDepositId?: string | null;
  approvalId?: string | null;
  reason?: string | null;
  actorUserId: string;
}

/**
 * Append one event inside the caller's transaction.
 *
 * The session row is locked first, so two events on one session are numbered
 * and chained one after the other rather than both taking the same sequence
 * number — the unique (session_id, seq) index would refuse the second, but
 * serialising here means nobody sees that refusal.
 */
export async function appendEvent(
  client: PoolClient,
  tenantId: string,
  sessionId: string,
  input: AppendInput,
  request: RequestCtx | undefined,
): Promise<StoredEvent & { id: string }> {
  const head = await client.query<{ last_seq: number; last_hash: string }>(
    'SELECT last_seq, last_hash FROM drawer_sessions WHERE id = $1 FOR UPDATE',
    [sessionId],
  );
  const row = head.rows[0];
  if (!row)
    throw new Error(`drawer session ${sessionId} not found while appending an event`);

  const facts: EventFacts = {
    sessionId,
    seq: row.last_seq + 1,
    type: input.type,
    currency: input.currency,
    amount: input.amount,
    paymentId: input.paymentId ?? null,
    fiscalCashDepositId: input.fiscalCashDepositId ?? null,
    approvalId: input.approvalId ?? null,
    reason: input.reason?.trim() || null,
    actorUserId: input.actorUserId,
    occurredAt: new Date().toISOString(),
  };
  const hash = eventHash(row.last_hash, facts);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO drawer_events
       (tenant_id, session_id, seq, type, currency, amount, payment_id, fiscal_cash_deposit_id,
        approval_id, reason, actor_user_id, request_id, ip, user_agent, occurred_at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16,$17)
     RETURNING id`,
    [
      tenantId,
      sessionId,
      facts.seq,
      facts.type,
      facts.currency,
      facts.amount,
      facts.paymentId,
      facts.fiscalCashDepositId,
      facts.approvalId,
      facts.reason,
      facts.actorUserId,
      request?.requestId ?? null,
      request?.ip ?? null,
      request?.userAgent ?? null,
      facts.occurredAt,
      row.last_hash,
      hash,
    ],
  );
  await client.query(
    'UPDATE drawer_sessions SET last_seq = $2, last_hash = $3 WHERE id = $1',
    [sessionId, facts.seq, hash],
  );

  return { ...facts, id: inserted.rows[0]!.id, prevHash: row.last_hash, hash };
}

/** Read a session's events back in order, as the chain verifier wants them. */
export async function readEvents(client: PoolClient, sessionId: string) {
  const { rows } = await client.query<{
    id: string;
    seq: number;
    type: DrawerEventType;
    currency: CurrencyCode;
    amount: number;
    payment_id: string | null;
    fiscal_cash_deposit_id: string | null;
    approval_id: string | null;
    reason: string | null;
    actor_user_id: string;
    actor_name: string | null;
    ip: string | null;
    user_agent: string | null;
    occurred_at: Date;
    prev_hash: string;
    hash: string;
  }>(
    `SELECT e.id, e.seq, e.type, e.currency, e.amount, e.payment_id, e.fiscal_cash_deposit_id,
            e.approval_id, e.reason, e.actor_user_id, u.full_name AS actor_name, e.ip, e.user_agent,
            e.occurred_at, e.prev_hash, e.hash
       FROM drawer_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.session_id = $1
      ORDER BY e.seq`,
    [sessionId],
  );
  return rows.map((r) => ({
    id: r.id,
    sessionId,
    seq: r.seq,
    type: r.type,
    currency: r.currency,
    amount: r.amount,
    paymentId: r.payment_id,
    fiscalCashDepositId: r.fiscal_cash_deposit_id,
    approvalId: r.approval_id,
    reason: r.reason,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    ip: r.ip,
    userAgent: r.user_agent,
    occurredAt: new Date(r.occurred_at).toISOString(),
    prevHash: r.prev_hash,
    hash: r.hash,
  }));
}
