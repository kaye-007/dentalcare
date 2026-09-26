/**
 * Types for the pre-bundled Nest application.
 *
 * `dentalcare-app-bundle` is not a package — wrangler's alias points it at
 * .worker-build/app.cjs, which scripts/build-worker.mjs produces. Declaring it
 * as a module specifier rather than importing the file by relative path is
 * what lets it carry types at all: TypeScript will not accept a `declare
 * module` for a relative path.
 */
declare module 'dentalcare-app-bundle' {
  import type { INestApplication } from '@nestjs/common';
  import type { NestExpressApplication } from '@nestjs/platform-express';

  export const NestFactory: {
    create<T extends INestApplication>(
      module: unknown,
      options?: { bufferLogs?: boolean },
    ): Promise<T>;
  };
  export const AppModule: unknown;
  export function configureApp(
    app: NestExpressApplication,
    opts: { shutdownHooks: boolean },
  ): void;
  export const ReminderSchedulerService: new (...args: never[]) => {
    tick(): Promise<void>;
  };
  export const FiscalSchedulerService: new (...args: never[]) => {
    tick(): Promise<void>;
  };
}
