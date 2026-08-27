import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

/**
 * The Node entrypoint — the container image and local development.
 *
 * The Cloudflare Worker does not come through here; it has its own entry at
 * apps/api/worker/index.ts. Both share configureApp() so the two deployments
 * cannot drift apart on security middleware.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  configureApp(app, { shutdownHooks: true });

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');

  app.get(Logger).log(`DentalCare API listening on :${port}`, 'Bootstrap');
}

void bootstrap();
