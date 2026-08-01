import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use pino as the framework logger.
  app.useLogger(app.get(Logger));

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

  // CORS for local SPA dev (Vite proxy avoids this, but harmless to allow).
  app.enableCors({
    origin: [/^http:\/\/localhost:\d+$/],
    credentials: true,
  });

  // Graceful shutdown so pg pool / future queues close cleanly.
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');

  app.get(Logger).log(`DentalCare API listening on :${port}`, 'Bootstrap');
}

void bootstrap();
