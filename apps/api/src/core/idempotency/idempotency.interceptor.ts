import { createHash } from 'node:crypto';
import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { Observable, from, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { RequestContextService } from '@/core/request-context/request-context';
import { RequestWithUser } from '@/shared/types/request-with-user';

export const IDEMPOTENT_METADATA_KEY = 'dentalcare:idempotent';

/**
 * Mark a route whose repeat must not repeat its effect: taking money, moving
 * cash, issuing anything fiscal.
 *
 * Opt-in per route, and the header stays optional so a client written before
 * 0013 keeps working. The clinic app sends a fresh key per user action and
 * the same key on every retry of that action.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_METADATA_KEY, true);

/** A claim older than this with no response is a request that died mid-way. */
const STALE_CLAIM_MS = 60_000;
/** A completed key is replayed for a day, then forgotten. */
const REPLAY_WINDOW_HOURS = 24;

type Claim =
  | { kind: 'claimed' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'in_progress' }
  | { kind: 'mismatch' };

/**
 * Replays the first response to a repeated Idempotency-Key.
 *
 *   first request   the key is claimed (inserted as in_progress) in its own
 *                   short transaction, the handler runs, and the response is
 *                   stored against the key
 *   repeat          the stored status and body come back, with
 *                   `Idempotent-Replayed: true`; the handler does not run
 *   concurrent      a repeat that arrives while the first is still running
 *                   gets 409 and retries — it must not run the handler too
 *   different body  the same key with a different request is a client bug,
 *                   refused with 422 rather than guessed at
 *   handler throws  the claim is released, so the same action can be retried
 *                   once whatever was wrong is fixed
 *
 * ── The window this cannot close ──────────────────────────────────────────
 *
 * The handler's transaction and the stored response are two commits. If the
 * process dies between them, the claim goes stale and a retry a minute later
 * runs the handler again. Routes where that matters carry a second guard in
 * their own transaction — a payment stores the key in a unique column, so the
 * second run fails on the constraint instead of taking the money twice.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly request: RequestContextService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const handled = () => next.handle();
    const marked = this.reflector.getAllAndOverride<boolean | undefined>(
      IDEMPOTENT_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    const key = this.request.get()?.idempotencyKey ?? null;
    const tenantId = this.tenant.getTenantId();
    if (!marked || !key || !tenantId) return handled();

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const res = context.switchToHttp().getResponse<Response>();
    const path = (req.originalUrl ?? req.url).split('?')[0]!;
    const hash = createHash('sha256')
      .update(JSON.stringify([req.method, path, req.user?.sub ?? null, req.body ?? null]))
      .digest('hex');

    const claim = await this.claim(
      tenantId,
      key,
      req.method,
      path,
      hash,
      req.user?.sub ?? null,
    );

    switch (claim.kind) {
      case 'mismatch':
        throw new UnprocessableEntityException({
          code: 'idempotency_key_reused',
          message: 'This Idempotency-Key was already used for a different request.',
        });
      case 'in_progress':
        throw new ConflictException({
          code: 'idempotency_in_progress',
          message: 'The same request is still being processed. Try again in a moment.',
        });
      case 'replay':
        res.status(claim.status);
        res.setHeader('Idempotent-Replayed', 'true');
        return of(claim.body);
      case 'claimed':
        break;
    }

    return handled().pipe(
      mergeMap((body) =>
        from(this.complete(tenantId, key, res.statusCode, body).then(() => body)),
      ),
      catchError((err: unknown) =>
        from(this.release(tenantId, key)).pipe(mergeMap(() => throwError(() => err))),
      ),
    );
  }

  private claim(
    tenantId: string,
    key: string,
    method: string,
    path: string,
    hash: string,
    userId: string | null,
  ): Promise<Claim> {
    return this.db.withTenant(tenantId, async (client) => {
      // Forget keys past the replay window, now and then rather than on every
      // request. RLS scopes this to the one clinic.
      if (Math.random() < 0.02) {
        await client.query(
          `DELETE FROM idempotency_keys WHERE created_at < now() - interval '${REPLAY_WINDOW_HOURS} hours'`,
        );
      }

      const inserted = await client.query(
        `INSERT INTO idempotency_keys (tenant_id, key, user_id, request_method, request_path, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, key) DO NOTHING
         RETURNING key`,
        [tenantId, key, userId, method, path, hash],
      );
      if (inserted.rowCount) return { kind: 'claimed' };

      const { rows } = await client.query<{
        request_hash: string;
        status: string;
        response_status: number | null;
        response_body: unknown;
        created_at: Date;
      }>(
        `SELECT request_hash, status, response_status, response_body, created_at
           FROM idempotency_keys WHERE key = $1 FOR UPDATE`,
        [key],
      );
      const row = rows[0];
      if (!row) return { kind: 'in_progress' };
      if (row.request_hash !== hash) return { kind: 'mismatch' };

      const ageMs = Date.now() - new Date(row.created_at).getTime();
      if (row.status === 'completed') {
        if (ageMs <= REPLAY_WINDOW_HOURS * 3_600_000) {
          return {
            kind: 'replay',
            status: row.response_status ?? 200,
            body: row.response_body,
          };
        }
      } else if (ageMs < STALE_CLAIM_MS) {
        return { kind: 'in_progress' };
      }

      // Expired or abandoned: take the key over as a new claim.
      await client.query(
        `UPDATE idempotency_keys
            SET status = 'in_progress', response_status = NULL, response_body = NULL,
                completed_at = NULL, created_at = now(), user_id = $2
          WHERE key = $1`,
        [key, userId],
      );
      return { kind: 'claimed' };
    });
  }

  private async complete(
    tenantId: string,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    await this.db.withTenant(tenantId, (client) =>
      client.query(
        `UPDATE idempotency_keys
            SET status = 'completed', response_status = $2, response_body = $3, completed_at = now()
          WHERE key = $1`,
        [key, status, JSON.stringify(body ?? null)],
      ),
    );
  }

  private async release(tenantId: string, key: string): Promise<void> {
    await this.db
      .withTenant(tenantId, (client) =>
        client.query(
          `DELETE FROM idempotency_keys WHERE key = $1 AND status = 'in_progress'`,
          [key],
        ),
      )
      .catch(() => undefined);
  }
}
