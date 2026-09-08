# Deployment

Everything runs on Cloudflare. The container path is kept, tested and
supported as a fallback — see the last section.

| Component         | Target                                          | Notes                                                                 |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| `apps/tenant-web` | Worker + static assets, `*.dentalcare.com/*`    | One clinic per subdomain. Proxies `/api/*` to the API Worker.         |
| `apps/admin-web`  | Worker + static assets, `admin.dentalcare.com`  | Same proxy, no tenant subdomain.                                      |
| `apps/api`        | Worker, `nodejs_compat`                         | NestJS over `httpServerHandler`. Hourly Cron Trigger for reminders.   |
| PostgreSQL        | Supabase, fronted by **two** Hyperdrive configs | RLS is the isolation boundary. Direct port 5432, not the 6543 pooler. |
| Patient documents | Any S3-compatible bucket (R2, S3, MinIO)        | Signed with `aws4fetch`; private bucket, pre-signed URLs only.        |

## What changed, and why it works now

`DEPLOYMENT.md` used to say the API was not adapted for serverless and should
not be. Two things made that true, and both have been dealt with:

- **The resident scheduler.** `ReminderSchedulerService` held a `setInterval`.
  On Workers it holds nothing; the Cron Trigger in `apps/api/wrangler.jsonc`
  calls `tick()` through the `scheduled` handler instead. The scan was already
  idempotent behind a partial unique index, so nothing about the logic moved.
- **The two persistent pg pools.** A Worker may not reuse a socket opened
  during a different request. `DatabaseService` now keeps resident pools only
  on Node; on Workers each operation borrows a single connection from
  Hyperdrive and closes it. Callers see the same `PoolClient` on both, so no
  service knows which runtime it is on.

The third obstacle was size. A Worker bundle is capped at 3 MiB compressed on
the free plan and `@aws-sdk/client-s3` alone did not leave room for NestJS, so
object storage was rewritten over `aws4fetch` — a few kilobytes, WebCrypto
SigV4, identical on both runtimes. **The API Worker currently bundles to
2477 KiB raw / 708 KiB gzipped.**

### Five things that only showed up by running it

Bundling successfully proves nothing. Every one of these compiled, passed
`wrangler deploy --dry-run`, and then threw on the first request:

| Symptom                                                        | Cause                                                                                                                                      | Fix                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `Cannot read properties of undefined (reading 'stringifySym')` | wrangler's bundler honours npm `browser` fields; pino's browser build exports no `symbols`, which pino-http reads at module scope          | pino runs on Node only; `worker/stubs/pino-logger.js` stands in            |
| `require_streams(...) is not a function`                       | same cause — `iconv-lite` maps `./lib/streams` to `false` for browsers, and body-parser pulls it in, so **every request with a body** died | pre-bundle with `platform: 'node'`, where browser fields are not consulted |
| `Code generation from strings disallowed`                      | Express 4's `depd` builds deprecation wrappers with `new Function`, which Workers forbid                                                   | `worker/stubs/depd.js` — it only suppressed warnings anyway                |
| `Class extends value #<Object> is not a constructor`           | pinning esbuild `mainFields` to `module,main` picked pg's ESM wrapper, whose re-export leaves `Pool` a plain object                        | don't override `mainFields`; `platform: 'node'` is enough                  |
| `CloudflareSocket is not a constructor`                        | `pg-cloudflare` exports its real socket only under the `workerd` export condition                                                          | add `conditions: ['workerd']` to the pre-bundle                            |

The first four are open wrangler bug [workers-sdk#9309](https://github.com/cloudflare/workers-sdk/issues/9309)
and the platform's eval ban. None is exotic; all of them are the first request
in production if nobody runs the thing first.

---

## 1. Database first

```bash
# 1. Provision Postgres, then point DATABASE_URL at it (privileged role).
# 2. Run migrations — these create the app_user role.
npm run migrate:up
```

The baseline migration reads `APP_DB_USER` / `APP_DB_PASSWORD` and creates a
`NOSUPERUSER … NOBYPASSRLS` role. **Avoid single quotes in the password** —
the migration interpolates it into `CREATE ROLE` SQL.

Migrations run from your machine or CI against Supabase directly. They are not
run from the Worker.

#### A database created before the migration squash

The history `0001…0021` was replaced by a single generated `0001_baseline`
that produces a byte-identical schema. A **new** database needs nothing
special. A database that already ran the old history needs one flag, once:

```bash
npm run migrate:up -- --no-check-order
```

Without it node-pg-migrate refuses, because `0001_baseline` sorts before
migrations it has already applied — a sound default, and exactly what a squash
creates. With it, the baseline sees the schema is already there, checks that
**all** 21 superseded migrations were applied, converges the role, records
itself, and changes nothing else.

A database that ran only _some_ of the old migrations is refused outright,
naming the first one missing. Bring it up to date from a checkout made before
the squash and then run the command above.

Re-verify the baseline reproduces the schema at any time:

```bash
npm run migrate:baseline -- --verify
```

### First platform administrator

Migrations create schema only — the database starts with no accounts. Create
the first NODE X superadmin by hand; every clinic and clinic user is created
from the platform console afterwards.

Generate a bcrypt hash (work factor 10, matching
`apps/api/src/core/security/bcrypt.ts`):

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" 'a-long-random-passphrase'
```

Insert the account using the **privileged** connection — `platform_admins`
carries no RLS and `app_user` is revoked from it:

```sql
INSERT INTO platform_admins (email, password_hash, full_name, status)
VALUES ('you@company.com', '<paste-the-hash>', 'Your Name', 'active');
```

Email uniqueness is enforced case-insensitively by
`platform_admins_email_lower_unique`. To rotate the password later, `UPDATE`
the `password_hash` column with a freshly generated hash.

## 2. Two Hyperdrive configs

The tenant plane and the platform plane connect as **different database
roles**, and that difference is the entire isolation model. One Hyperdrive
config per role, never one shared:

```bash
wrangler hyperdrive create dentalcare-app --caching-disabled \
  --connection-string="postgres://app_user:PASSWORD@db.PROJECT.supabase.co:5432/postgres"

wrangler hyperdrive create dentalcare-admin --caching-disabled \
  --connection-string="postgres://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres"
```

Paste the two ids into `apps/api/wrangler.jsonc`, replacing
`REPLACE_WITH_HYPERDRIVE_APP_ID` and `REPLACE_WITH_HYPERDRIVE_ADMIN_ID`.

Three things here are not optional:

- **`--caching-disabled`.** Hyperdrive's result cache is keyed on the query
  text, not on the transaction that set `app.current_tenant_id`. With caching
  on, one clinic's rows can be served to another. Caching is a property of the
  config, not of the binding, so it can only be set here.
- **Port 5432, the direct host.** Not Supabase's 6543 transaction pooler.
  Hyperdrive _is_ the pooler, and `set_config('app.current_tenant_id', …, true)`
  needs the session that a transaction-mode pooler will not keep.
- **`app_user`, not `postgres`, on `dentalcare-app`.** The API verifies this at
  boot: if the tenant role turns out to be a superuser or to hold `BYPASSRLS`,
  it refuses to start in production rather than serve unisolated data.

## 3. Secrets

Non-secret configuration lives in `vars` in `apps/api/wrangler.jsonc`. Anything
sensitive is a Worker secret:

```bash
cd apps/api
wrangler secret put JWT_SECRET            # >= 32 chars, not the example value
wrangler secret put GOOGLE_CLIENT_ID      # optional — all three or none
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_CALLBACK_URL
wrangler secret put S3_BUCKET             # optional — all three or none
wrangler secret put S3_ACCESS_KEY_ID
wrangler secret put S3_SECRET_ACCESS_KEY
wrangler secret put S3_ENDPOINT           # set for R2/MinIO, omit for AWS S3
```

The API validates every variable at boot and **refuses to start** on a bad
config rather than running unsafely:

| Variable                                   | Failure if wrong                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_DATABASE_URL` (from `HYPERDRIVE_APP`) | Missing → boot refused. Points at a superuser or `BYPASSRLS` role → boot refused. Either would silently disable RLS and expose every clinic's data to every other clinic. |
| `JWT_SECRET`                               | Missing, under 32 chars, or the `.env.example` placeholder → boot refused.                                                                                                |
| `DATABASE_URL` (from `HYPERDRIVE_ADMIN`)   | Missing → boot refused.                                                                                                                                                   |
| `NODE_ENV`                                 | Must be `production`. It disables the client-supplied tenant header and switches logging to JSON.                                                                         |
| `RUNTIME`                                  | `workers` on Cloudflare, `node` in the container. Chooses the connection strategy and silences the in-process scheduler.                                                  |

## 4. Deploy

Order matters — both SPA Workers hold a service binding to the API Worker, so
it has to exist first.

```bash
npm run cf:dry-run    # bundles all three, uploads nothing
npm run cf:deploy     # api → tenant-web → admin-web
```

`cf:deploy` on the API runs `npm run build:worker` first, which is three
steps, and each one exists for a reason:

1. **`nest build`** — tsc compiles the application to `dist/`. NestJS needs
   `emitDecoratorMetadata` for constructor injection and esbuild cannot emit
   it, so the application can never be compiled by a bundler alone.
2. **`scripts/build-worker.mjs`** — esbuild flattens `dist/` and its
   dependencies into one CommonJS file with `platform: 'node'` resolution.
   That is what keeps npm `browser` fields out of the picture. Read the header
   of that file before changing any option in it.
3. **`wrangler deploy`** — wrangler bundles `worker/index.ts` around that
   single file, which leaves it nothing to resolve but node builtins — the
   part it does well.

`worker/stubs/` holds three small stand-ins: `nest-optional.js` for
`@nestjs/websockets` and `@nestjs/microservices` (Nest requires both
optionally and guards every use), `pino-logger.js`, and `depd.js`. Each carries
its own explanation.

### Domains and routing

- `apps/tenant-web` → route `*.dentalcare.com/*` (wildcard DNS + wildcard TLS)
- `apps/admin-web` → custom domain `admin.dentalcare.com`
- `apps/api` → custom domain `api.dentalcare.com`

More specific routes win, so the two custom domains are not swallowed by the
wildcard. The apex is deliberately unrouted: the clinic app needs a subdomain
to resolve a tenant.

**`/api/*` is same-origin on purpose.** Each SPA Worker forwards it to the API
over a service binding rather than letting the browser call
`api.dentalcare.com` directly. The API reads the clinic from the first label of
the `Host` header — `avicena.dentalcare.com` → `avicena` — and the
`X-Tenant-Subdomain` override is hard-disabled in production. A cross-origin
call would arrive with the wrong host and resolve no clinic at all. Keeping the
hop internal also means no CORS preflight and no token leaving its origin.

`api.dentalcare.com` exists for one reason: Google allows a single fixed
redirect URI, so `GOOGLE_CALLBACK_URL` needs a stable public host.

### Reminders

`"triggers": { "crons": ["0 * * * *"] }` runs the reminder sweep hourly. Run it
by hand to test:

```bash
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
```

Clinics choose their own lead time (`clinic_settings.reminder_hours_before`),
so a coarser cron means reminders land within the hour rather than the minute.
Tighten the schedule if that matters more than invocation count.

## Local development

Two ways, both supported:

```bash
npm run api:dev     # plain Node against docker-compose Postgres — fastest loop
npm run cf:dev -w @dentalcare/api   # the real Workers runtime, via wrangler dev
```

`wrangler dev` uses the `localConnectionString` on each Hyperdrive binding, so
it talks to the same local Postgres without touching Supabase. Put secrets in
`apps/api/.dev.vars` (git-ignored) — at minimum `JWT_SECRET`.

Fire the cron by hand:

```bash
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
```

One caveat worth knowing before you chase a phantom bug: `wrangler dev`
presents every request as arriving at the **first route in
`wrangler.jsonc`**, regardless of the `Host` header you send. With the API's
route set to `api.dentalcare.com`, tenant resolution therefore reads `api` as
the clinic and answers `404 Clinic not found`. Point the route at a clinic
host for that test.

## Health, logging, observability

- `GET /api/health` — reports DB reachability.
- On the container, logs are JSON (pino) with `x-request-id` correlation and
  `authorization` / `cookie` redacted.
- On Workers, pino is not loaded at all (see the table above). `WorkersLogger`
  in `src/bootstrap.ts` routes Nest's logger at `console`, which is what
  Workers Logs reads, and a small middleware preserves the `x-request-id`
  contract that pino-http used to provide. `observability` is enabled in
  `wrangler.jsonc` at full sampling. Note that `wrangler dev`'s local log
  viewer records request events rather than console output — confirm log lines
  are arriving from the dashboard after the first deploy.
- **No patient data is written to the log.** The reminder log channel records
  the message on the reminder row, under RLS, and nothing about the patient in
  the application log — on Cloudflare that log leaves the database's trust
  boundary entirely.

## Scaling

The constraint that pinned the API to one replica is gone. The scheduler no
longer runs in-process, so Worker concurrency is unbounded from this
application's point of view; Hyperdrive owns the connection ceiling.

`withTenant()` sets `app.current_tenant_id` via `set_config(..., true)` —
**transaction-local**. Any pooler in front of Postgres must run in
**transaction mode**, and must not be stacked underneath Hyperdrive.

---

## Fallback: the container

`apps/api/Dockerfile` and `docker-compose.yml` are unchanged and still work.
Nothing in the Cloudflare port removed the Node path — `RUNTIME` defaults to
`node`, which restores the resident pools and the in-process scheduler.

```bash
docker build -f apps/api/Dockerfile -t dentalcare-api .
docker run -p 3000:3000 --env-file .env.production dentalcare-api
```

With the scheduler back in-process there is still no distributed lock, so the
container path remains **single-replica**. The duplicate-claim path is safe —
`reminders_auto_unique` refuses the second insert and each claim runs in its
own transaction — but a second replica is wasted work.

## Before first paying customer

- [ ] `NODE_ENV=production`, `JWT_SECRET` rotated off any shared value
- [ ] Both Hyperdrive configs created with `--caching-disabled`
- [ ] `HYPERDRIVE_APP` verified as `app_user` — boot logs no RLS warning
- [ ] Automated backups enabled, **and a restore rehearsed**
- [ ] Wildcard DNS + TLS in place for `*.dentalcare.com`
- [ ] Superadmin created manually, not seeded
- [ ] Cron Trigger observed firing once in production
- [ ] Google sign-in exercised end to end on the deployed Worker
- [ ] Uptime and error alerting on `/api/health`
