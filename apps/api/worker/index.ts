/**
 * Cloudflare Worker entrypoint for the DentalCare API.
 *
 * ── Why this file is not src/main.ts ──────────────────────────────────────
 *
 * NestJS depends on `emitDecoratorMetadata` for constructor injection, and
 * esbuild — which is what bundles a Worker — cannot emit it. So the Nest
 * application is compiled ahead of time by tsc (`nest build`, CommonJS, with
 * the metadata intact), flattened by scripts/build-worker.mjs, and imported
 * here as `dentalcare-app-bundle` (wrangler aliases that name at the built
 * file). Everything under src/ stays runtime-agnostic; only this file knows it
 * is on Cloudflare.
 *
 * ── Why the app boots lazily ──────────────────────────────────────────────
 *
 * A Worker's global scope runs under a tight startup CPU budget. Constructing
 * a Nest container with ~35 modules and opening a database connection is far
 * too much to do there, so the container is built on the first request of each
 * isolate and reused for every request after. A failed boot clears the cached
 * promise, otherwise one transient database blip would poison the isolate for
 * its whole lifetime.
 */
import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createServer } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * The loopback port the Node HTTP server binds to inside the isolate. Nothing
 * outside the Worker can reach it; httpServerHandler is what bridges the
 * Workers fetch model to it.
 */
const PORT = 8787;

interface WorkerEnv {
  /** Pooled connection for the app_user role — RLS is enforced. */
  HYPERDRIVE_APP: { connectionString: string };
  /** Pooled connection for the privileged platform plane — bypasses RLS. */
  HYPERDRIVE_ADMIN: { connectionString: string };
}

type ExpressInstance = (req: unknown, res: unknown) => void;

let booting: Promise<NestExpressApplication> | null = null;

/**
 * Build (or reuse) the Nest container for this isolate.
 *
 * The Hyperdrive connection strings are only reachable through the binding,
 * never through `process.env`, so they are copied across before the config
 * module validates the environment — DatabaseService and env.validation read
 * them under their existing names and neither needs to know about Cloudflare.
 */
function boot(): Promise<NestExpressApplication> {
  if (booting) return booting;

  booting = (async () => {
    const bindings = env as unknown as WorkerEnv;

    process.env.RUNTIME = 'workers';
    process.env.APP_DATABASE_URL = bindings.HYPERDRIVE_APP.connectionString;
    process.env.DATABASE_URL = bindings.HYPERDRIVE_ADMIN.connectionString;

    // Imported dynamically, after the environment above is in place: the
    // OAuth module reads process.env while its @Module decorator evaluates,
    // which happens at import time.
    const { NestFactory, AppModule, configureApp } = await import(
      'dentalcare-app-bundle'
    );

    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bufferLogs: true,
    });
    configureApp(app, { shutdownHooks: false });
    await app.init();
    return app;
  })();

  // Never cache a failure.
  booting.catch(() => {
    booting = null;
  });

  return booting;
}

const server = createServer((req, res) => {
  boot()
    .then((app) => {
      const express = app.getHttpAdapter().getInstance() as ExpressInstance;
      express(req, res);
    })
    .catch((err: unknown) => {
      // The container never came up — a bad binding, an unreachable database,
      // or invalid configuration. Say so in the log and answer honestly.
      console.error(
        `API failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ statusCode: 503, message: 'Service Unavailable' }));
    });
});

server.listen(PORT);

const http = httpServerHandler({ port: PORT });

export default {
  fetch: http.fetch,

  /**
   * Cron Trigger — replaces the in-process setInterval that used to drive
   * automatic appointment reminders (see ReminderSchedulerService).
   *
   * The scan is idempotent: a partial unique index on (appointment_id) for
   * automatic reminders means a duplicate pass claims nothing and delivers
   * nothing, so an overlapping or retried invocation is safe.
   *
   * waitUntil keeps the invocation alive for the whole sweep rather than
   * letting it be cut short once this function returns.
   */
  async scheduled(
    _controller: { cron: string; scheduledTime: number },
    _env: unknown,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<void> {
    const run = (async () => {
      const app = await boot();
      const { ReminderSchedulerService, FiscalSchedulerService } = await import(
        'dentalcare-app-bundle'
      );
      // Independent passes: one clinic's reminder trouble must not delay a
      // fiscal invoice the law wants delivered within 48 hours, or the reverse.
      await Promise.allSettled([
        app.get(ReminderSchedulerService).tick(),
        app.get(FiscalSchedulerService).tick(),
      ]);
    })();
    ctx.waitUntil(run);
    await run;
  },
};
