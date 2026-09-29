import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '@/app.module';
import { configureApp } from '@/bootstrap';

/**
 * The real API, on a real port.
 *
 * Deliberately not @nestjs/testing with an overridden module: the things
 * these tests exist to check — the global ValidationPipe, the global
 * ReadOnlyGuard, TenantMiddleware resolving a clinic from a header, the
 * throttler, helmet, the /api prefix — all live in configureApp() and the
 * module graph. A test harness that swaps any of them out is testing a
 * different application from the one that ships.
 *
 * So this boots exactly what main.ts boots, differing in one thing: port 0,
 * so the OS assigns a free port and two suites can never collide.
 *
 * It also means no new dependency. supertest would be a fourth way to make an
 * HTTP request in this repository; `fetch` is already how smoke-api.js, the
 * compose healthcheck and the SPAs all do it.
 */

export interface TestApi {
  /** Absolute URL for a path like '/api/auth/login'. */
  url(path: string): string;
  close(): Promise<void>;
  app: INestApplication;
}

export async function startApi(): Promise<TestApi> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'fatal'],
  });
  configureApp(app, { shutdownHooks: false });

  // configureApp installs pino, which then replays ~200 route-mapping lines
  // and every service log through the jest reporter. Silenced AFTER
  // configureApp rather than instead of it, so the harness still boots the
  // real middleware stack and only the output is different. A failed boot
  // still throws, and a failed request still fails its assertion.
  app.useLogger(false);

  await app.listen(0, '127.0.0.1');

  const server = app.getHttpServer();
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  return {
    app,
    url: (path) => `${base}${path}`,
    close: () => app.close(),
  };
}

export interface Response<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/**
 * One request, with the clinic chosen by header.
 *
 * X-Tenant-Subdomain is how localhost picks a clinic — there is no subdomain
 * on 127.0.0.1 to read — and it is gated behind ALLOW_TENANT_HEADER=1 and
 * ignored outright in production. That gating is itself under test in the
 * unit suite; here it is simply the mechanism.
 */
export async function call<T = unknown>(
  api: TestApi,
  method: string,
  path: string,
  opts: {
    subdomain?: string;
    token?: string;
    body?: unknown;
    /** Extra request headers, e.g. Idempotency-Key. */
    headers?: Record<string, string>;
    /**
     * The Idempotency-Key a change carries. A route that moves money refuses
     * a request without one (428), and the apps send one with every such
     * action, so a POST, PUT, PATCH or DELETE here gets a fresh key unless the
     * test names one (here or in `headers`) or passes null to send none.
     */
    idempotencyKey?: string | null;
  } = {},
): Promise<Response<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const named = Object.keys(headers).some((h) => h.toLowerCase() === 'idempotency-key');
  if (opts.idempotencyKey !== undefined) {
    if (opts.idempotencyKey !== null) headers['Idempotency-Key'] = opts.idempotencyKey;
  } else if (!named && !['GET', 'HEAD'].includes(method.toUpperCase())) {
    headers['Idempotency-Key'] = `itest-${randomUUID()}`;
  }
  if (opts.subdomain) headers['X-Tenant-Subdomain'] = opts.subdomain;
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(api.url(path), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { status: res.status, body: body as T, headers: res.headers };
}

export interface Session {
  accessToken: string;
  refreshToken?: string;
}

/** Sign in, failing loudly with the server's reason rather than a bare undefined. */
export async function login(
  api: TestApi,
  subdomain: string,
  email: string,
  password: string,
): Promise<Session> {
  const res = await call<Session & { message?: string }>(api, 'POST', '/api/auth/login', {
    subdomain,
    body: { email, password },
  });

  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `login failed for ${email} on ${subdomain}: ${res.status} ` +
        `${JSON.stringify(res.body)}`,
    );
  }
  return res.body;
}
