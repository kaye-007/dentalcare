import { randomUUID } from 'node:crypto';
import { LoggerService, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

/**
 * Origins allowed to call the API cross-origin. Local Vite dev servers are
 * always permitted; production origins come from CORS_ORIGINS (comma
 * separated), since the previous localhost-only regex blocked every deployed
 * frontend. A wildcard entry like "https://*.dentalcare.app" matches any
 * single-label subdomain, which is what per-tenant hosting needs.
 */
export function corsOrigins(raw: string | undefined) {
  const patterns = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) =>
      entry.includes('*')
        ? new RegExp(
            `^${entry.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '[^.]+' : `\\${c}`))}$`,
          )
        : entry,
    );
  return [/^http:\/\/localhost:\d+$/, ...patterns];
}

/**
 * Nest's own ConsoleLogger writes through process.stdout, and on Workers that
 * goes nowhere — the boot-time RLS warning and every service log line
 * disappeared silently. Workers Logs reads console, so this routes there.
 *
 * Deliberately minimal: one line per record, level and context up front, so
 * the output stays greppable in the dashboard.
 */
export class WorkersLogger implements LoggerService {
  private write(
    level: string,
    message: unknown,
    params: unknown[],
    to: (...a: unknown[]) => void,
  ): void {
    const context = params.length && typeof params[params.length - 1] === 'string'
      ? String(params.pop())
      : undefined;
    to(`[${level}]${context ? ` [${context}]` : ''} ${String(message)}`, ...params);
  }

  log(message: unknown, ...params: unknown[]): void {
    this.write('LOG', message, params, console.log);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.write('ERROR', message, params, console.error);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.write('WARN', message, params, console.warn);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.write('DEBUG', message, params, console.log);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write('VERBOSE', message, params, console.log);
  }
}

/**
 * Everything the HTTP surface needs, applied identically on both runtimes.
 *
 * This used to live inline in main.ts. It was lifted out when the Cloudflare
 * Worker entry appeared, because the alternative — a second copy of the
 * helmet, prefix, validation and CORS setup in worker/index.ts — is how a
 * deployment ends up with subtly weaker security than the one it was tested
 * against. One function, two callers, no drift.
 *
 * `shutdownHooks` is the only difference between the runtimes: on Node it
 * closes the pg pools on SIGTERM, and on Workers there is no signal to hook
 * and no resident pool to close.
 */
export function configureApp(
  app: NestExpressApplication,
  opts: { shutdownHooks: boolean },
): void {
  // pino is registered on Node only (see AppModule). On Workers the built-in
  // Nest logger already writes to console, and this middleware keeps the
  // x-request-id contract pino-http used to provide — without it a client
  // reporting "request 8f2c… failed" would have nothing to match against.
  if (process.env.RUNTIME === 'workers') {
    app.useLogger(new WorkersLogger());
    app.use((req: Request, res: Response, next: NextFunction) => {
      const incoming = req.headers['x-request-id'];
      const id =
        (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
      req.headers['x-request-id'] = id;
      res.setHeader('x-request-id', id);
      next();
    });
  } else {
    app.useLogger(app.get(Logger));
  }

  // Behind a reverse proxy (Cloudflare/Render/nginx) the socket address is the
  // proxy's. Without this, per-IP rate limiting buckets every request together.
  app.set('trust proxy', 1);

  // Baseline security headers. CSP is left off here: the API serves JSON only,
  // and the SPAs are served by their own host, which owns their policy.
  app.use(helmet({ contentSecurityPolicy: false }));

  // All routes live under /api (the SPAs are served separately).
  app.setGlobalPrefix('api');

  // Validate and strip request bodies against DTOs.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = app.get(ConfigService);

  // CORS for local SPA dev (the Vite proxy avoids this) and for any deployment
  // where the SPAs are not same-origin with the API.
  app.enableCors({
    origin: corsOrigins(config.get<string>('CORS_ORIGINS')),
    credentials: true,
  });

  if (opts.shutdownHooks) {
    // Graceful shutdown so the pg pools close cleanly.
    app.enableShutdownHooks();
  }
}
