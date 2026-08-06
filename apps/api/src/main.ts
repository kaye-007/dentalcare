import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

/**
 * Origins allowed to call the API cross-origin. Local Vite dev servers are
 * always permitted; production origins come from CORS_ORIGINS (comma
 * separated), since the previous localhost-only regex blocked every deployed
 * frontend. A wildcard entry like "https://*.dentalcare.app" matches any
 * single-label subdomain, which is what per-tenant hosting needs.
 */
function corsOrigins(raw: string | undefined) {
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

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Use pino as the framework logger.
  app.useLogger(app.get(Logger));

  // Behind a reverse proxy (Render/Railway/nginx) the socket address is the
  // proxy's. Without this, per-IP rate limiting buckets every request together.
  app.set('trust proxy', 1);

  // Baseline security headers. CSP is left off here: the API serves JSON only,
  // and the SPAs are served by their own host, which owns their policy.
  app.use(helmet({ contentSecurityPolicy: false }));

  // All routes live under /api (the SPAs are served separately by the proxy).
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

  // Graceful shutdown so pg pool / future queues close cleanly.
  app.enableShutdownHooks();

  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');

  app.get(Logger).log(`DentalCare API listening on :${port}`, 'Bootstrap');
}

void bootstrap();
