# Deployment

Everything runs on Cloudflare. The container path is kept, tested and
supported as a fallback — see the last section.

| Component | Target | Notes |
|---|---|---|
| `apps/tenant-web` | Worker + static assets, `*.dentalcare.com/*` | One clinic per subdomain. Proxies `/api/*` to the API Worker. |
| `apps/admin-web` | Worker + static assets, `admin.dentalcare.com` | Same proxy, no tenant subdomain. |
| `apps/api` | Worker, `nodejs_compat` | NestJS over `httpServerHandler`. Hourly Cron Trigger for reminders. |
| PostgreSQL | Supabase, fronted by **two** Hyperdrive configs | RLS is the isolation boundary. Direct port 5432, not the 6543 pooler. |
| Patient documents | Any S3-compatible bucket (R2, S3, MinIO) | Signed with `aws4fetch`; private bucket, pre-signed URLs only. |

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
2.6 MiB raw / 747 KiB gzipped.**

---

## 1. Database first

```bash
# 1. Provision Postgres, then point DATABASE_URL at it (privileged role).
# 2. Run migrations — these create the app_user role (migration 0003).
npm run migrate:up
```

Migration `0003` reads `APP_DB_USER` / `APP_DB_PASSWORD` and creates a
`NOSUPERUSER … NOBYPASSRLS` role. **Avoid single quotes in the password** —
the migration interpolates it into `CREATE ROLE` SQL.

Migrations run from your machine or CI against Supabase directly. They are not
run from the Worker.

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
  Hyperdrive *is* the pooler, and `set_config('app.current_tenant_id', …, true)`
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

| Variable | Failure if wrong |
|---|---|
| `APP_DATABASE_URL` (from `HYPERDRIVE_APP`) | Missing → boot refused. Points at a superuser or `BYPASSRLS` role → boot refused. Either would silently disable RLS and expose every clinic's data to every other clinic. |
| `JWT_SECRET` | Missing, under 32 chars, or the `.env.example` placeholder → boot refused. |
| `DATABASE_URL` (from `HYPERDRIVE_ADMIN`) | Missing → boot refused. |
| `NODE_ENV` | Must be `production`. It disables the client-supplied tenant header and switches logging to JSON. |
| `RUNTIME` | `workers` on Cloudflare, `node` in the container. Chooses the connection strategy and silences the in-process scheduler. |

## 4. Deploy

Order matters — both SPA Workers hold a service binding to the API Worker, so
it has to exist first.

```bash
npm run cf:dry-run    # bundles all three, uploads nothing
npm run cf:deploy     # api → tenant-web → admin-web
```

`cf:deploy` on the API runs `nest build` first: NestJS needs
`emitDecoratorMetadata`, which esbuild cannot produce, so tsc compiles the
application into `dist/` and the Worker entry at `apps/api/worker/index.ts`
wraps that. `apps/api/worker/stubs/nest-optional.js` stands in for
`@nestjs/websockets` and `@nestjs/microservices`, which Nest requires
optionally and this application does not use.

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
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"   # under `wrangler dev`
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
it talks to the same local Postgres without touching Supabase.

## Health, logging, observability

- `GET /api/health` — reports DB reachability.
- Logs are JSON (pino) with `x-request-id` correlation; `authorization` and
  `cookie` headers are redacted. On Workers pino writes through `console`,
  which is what Workers Logs reads; `observability` is enabled in
  `wrangler.jsonc` at full sampling.
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
