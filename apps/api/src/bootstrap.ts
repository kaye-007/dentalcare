import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
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
  // Use pino as the framework logger.
  app.useLogger(app.get(Logger));

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
