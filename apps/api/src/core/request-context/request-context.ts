import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Global, Injectable, Module, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

/**
 * Who sent this request, from where — for the evidence tables, not for
 * decisions.
 *
 * The audit trail recorded who voided a payment; it could not say from which
 * device or in which request, which is the first thing asked when two people
 * disagree about what happened at the desk (0013). The cash drawer's events
 * need the same answer for every movement of cash.
 *
 * Nothing here is an authentication input. An IP behind two proxies is a hint
 * for a person reading a log, never a reason to allow or refuse a request.
 */
export interface RequestCtx {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  /** The request's Idempotency-Key header, when it carried a valid one. */
  idempotencyKey: string | null;
}

/** 16–128 characters of URL-safe base64 or a UUID's alphabet. Matches 0013. */
export const IDEMPOTENCY_KEY_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

function header(req: Request, name: string): string | null {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() ? first.trim() : null;
}

function clip(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

@Injectable()
export class RequestContextService {
  private readonly als = new AsyncLocalStorage<RequestCtx>();

  run<T>(ctx: RequestCtx, fn: () => T): T {
    return this.als.run(ctx, fn);
  }

  /** Undefined outside a request: schedulers, scripts, the boot sequence. */
  get(): RequestCtx | undefined {
    return this.als.getStore();
  }

  /** Build the context for one Express request. Exported for tests. */
  static fromRequest(req: Request, res: Response): RequestCtx {
    // pino-http assigns req.id on Node; the Workers middleware in
    // configureApp sets the header. Either way the id the client sees in
    // x-request-id is the one recorded.
    const assigned = (req as Request & { id?: unknown }).id;
    const requestId =
      (typeof assigned === 'string' && assigned) ||
      header(req, 'x-request-id') ||
      (res.getHeader('x-request-id') as string | undefined) ||
      randomUUID();

    // Cloudflare names the client in its own header; elsewhere Express has
    // already applied `trust proxy` to req.ip.
    const ip = header(req, 'cf-connecting-ip') ?? req.ip ?? null;
    const key = header(req, 'idempotency-key');

    return {
      requestId: requestId.slice(0, 128),
      ip: clip(ip, 64),
      userAgent: clip(header(req, 'user-agent'), 512),
      idempotencyKey: key && IDEMPOTENCY_KEY_SHAPE.test(key) ? key : null,
    };
  }
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly ctx: RequestContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    this.ctx.run(RequestContextService.fromRequest(req, res), next);
  }
}

@Global()
@Module({
  providers: [RequestContextService, RequestContextMiddleware],
  exports: [RequestContextService, RequestContextMiddleware],
})
export class RequestContextModule {}
