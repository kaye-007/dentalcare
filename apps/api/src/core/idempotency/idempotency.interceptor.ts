import { createHash } from 'node:crypto';
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
  SetMetadata,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { PoolClient } from 'pg';
import { Observable, from, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { RequestContextService } from '@/core/request-context/request-context';
import { RequestWithUser } from '@/shared/types/request-with-user';

export const IDEMPOTENT_METADATA_KEY = 'dentalcare:idempotent';

/**
 * Mark a route whose repeat must not repeat its effect: taking money, moving
 * cash, issuing anything fiscal, billing a clinic.
 *
 * The key is REQUIRED on every route marked here (the owner's decision,
 * 2026-09-28): a request without one is refused with 428 before the handler
 * runs, so no money moves without a key to replay it by. The clinic app and
 * the console make a fresh key per user action and send the same key on every
 * retry of that action. idempotency-coverage.spec.ts fails the build when a
 * route that moves money is left unmarked.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_METADATA_KEY, true);

/**
 * Where a plane keeps its keys. A clinic's live in idempotency_keys under the
 * clinic's row security (0013); the console's billing belongs to no clinic,
 * so its keys live in platform_idempotency_keys (0026). Table and column
 * names are these constants, never input.
 */
interface KeyStore {
  table: 'idempotency_keys' | 'platform_idempotency_keys';
  actorColumn: 'user_id' | 'admin_id';
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Claim the key as in_progress; false when it is already there. */
  insert(
    client: PoolClient,
    key: string,
    actorId: string | null,
    method: string,
    path: string,
    hash: string,
  ): Promise<boolean>;
}

/**
 * Fields that are secrets wherever they sit in a body. A manager's approval
 * PIN travels with a payout, a float or a variance approval; the database
 * keeps it under bcrypt, and a SHA-256 of the request would undo that — four
 * to six digits are guessed from a fast hash in milliseconds by anyone who
 * can read the table. The hash only has to tell one request from another,
 * and the fields around the secret already do.
 */
const SECRET_FIELDS: ReadonlySet<string> = new Set([
  'pin',
  'password',
  'currentPassword',
]);

export function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([field]) => !SECRET_FIELDS.has(field))
        .map(([field, v]) => [field, withoutSecrets(v)]),
    );
  }
  return value;
}

/**
 * The request's key, or the refusal. The request context keeps a key only
 * when it has the shape 0013 stores, so a null there is either no header at
 * all (428: the precondition this route requires) or one that is not a key
 * (400: a client bug).
 */
function requiredKey(req: { headers: Record<string, unknown> }, parsed: string | null) {
  if (parsed) return parsed;
  const raw = req.headers['idempotency-key'];
  const sent = (Array.isArray(raw) ? raw[0] : raw) as string | undefined;
  if (!sent?.trim()) {
    throw new HttpException(
      {
        code: 'idempotency_key_required',
        message:
          'This action moves money, so it needs an Idempotency-Key header: a new one per action, the same one on every retry of it.',
      },
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
  throw new BadRequestException({
    code: 'idempotency_key_invalid',
    message: 'An Idempotency-Key is 16 to 128 letters, digits, "-" or "_".',
  });
}

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
 *
 * Guards run before interceptors, so a caller who is not signed in, or not
 * allowed the route, is refused for that before a missing key is mentioned.
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
    if (!marked) return handled();

    const req = context
      .switchToHttp()
      .getRequest<RequestWithUser & { admin?: { sub?: string } }>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = requiredKey(req, this.request.get()?.idempotencyKey ?? null);

    // A clinic route has its clinic by now (TenantMiddleware); a console route
    // has its administrator (PlatformJwtGuard). Neither is a route this
    // interceptor can place, and it refuses rather than guess the plane.
    const tenantId = this.tenant.getTenantId();
    const actorId = tenantId ? (req.user?.sub ?? null) : (req.admin?.sub ?? null);
    if (!tenantId && !req.admin) {
      throw new InternalServerErrorException(
        'An idempotent route ran outside both the clinic and the console.',
      );
    }
    const store = tenantId ? this.clinicStore(tenantId) : this.platformStore();

    const path = (req.originalUrl ?? req.url).split('?')[0]!;
    const hash = createHash('sha256')
      .update(
        JSON.stringify([req.method, path, actorId, withoutSecrets(req.body ?? null)]),
      )
      .digest('hex');

    const claim = await this.claim(store, key, req.method, path, hash, actorId);

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
        from(this.complete(store, key, res.statusCode, body).then(() => body)),
      ),
      catchError((err: unknown) =>
        from(this.release(store, key)).pipe(mergeMap(() => throwError(() => err))),
      ),
    );
  }

  private clinicStore(tenantId: string): KeyStore {
    return {
      table: 'idempotency_keys',
      actorColumn: 'user_id',
      transaction: (fn) => this.db.withTenant(tenantId, fn),
      insert: async (client, key, actorId, method, path, hash) =>
        Boolean(
          (
            await client.query(
              `INSERT INTO idempotency_keys (tenant_id, key, user_id, request_method, request_path, request_hash)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (tenant_id, key) DO NOTHING
               RETURNING key`,
              [tenantId, key, actorId, method, path, hash],
            )
          ).rowCount,
        ),
    };
  }

  private platformStore(): KeyStore {
    return {
      table: 'platform_idempotency_keys',
      actorColumn: 'admin_id',
      transaction: (fn) => this.db.withAdminTransaction(fn),
      insert: async (client, key, actorId, method, path, hash) =>
        Boolean(
          (
            await client.query(
              `INSERT INTO platform_idempotency_keys (key, admin_id, request_method, request_path, request_hash)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (key) DO NOTHING
               RETURNING key`,
              [key, actorId, method, path, hash],
            )
          ).rowCount,
        ),
    };
  }

  private claim(
    store: KeyStore,
    key: string,
    method: string,
    path: string,
    hash: string,
    actorId: string | null,
  ): Promise<Claim> {
    return store.transaction(async (client) => {
      // Forget keys past the replay window, now and then rather than on every
      // request. RLS scopes this to the one clinic on the clinic plane.
      if (Math.random() < 0.02) {
        await client.query(
          `DELETE FROM ${store.table} WHERE created_at < now() - interval '${REPLAY_WINDOW_HOURS} hours'`,
        );
      }

      if (await store.insert(client, key, actorId, method, path, hash)) {
        return { kind: 'claimed' };
      }

      const { rows } = await client.query<{
        request_hash: string;
        status: string;
        response_status: number | null;
        response_body: unknown;
        created_at: Date;
      }>(
        `SELECT request_hash, status, response_status, response_body, created_at
           FROM ${store.table} WHERE key = $1 FOR UPDATE`,
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
        `UPDATE ${store.table}
            SET status = 'in_progress', response_status = NULL, response_body = NULL,
                completed_at = NULL, created_at = now(), ${store.actorColumn} = $2
          WHERE key = $1`,
        [key, actorId],
      );
      return { kind: 'claimed' };
    });
  }

  private async complete(
    store: KeyStore,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    await store.transaction((client) =>
      client.query(
        `UPDATE ${store.table}
            SET status = 'completed', response_status = $2, response_body = $3, completed_at = now()
          WHERE key = $1`,
        [key, status, JSON.stringify(body ?? null)],
      ),
    );
  }

  private async release(store: KeyStore, key: string): Promise<void> {
    await store
      .transaction((client) =>
        client.query(
          `DELETE FROM ${store.table} WHERE key = $1 AND status = 'in_progress'`,
          [key],
        ),
      )
      .catch(() => undefined);
  }
}
