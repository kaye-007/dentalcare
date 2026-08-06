# Deployment

Frontend and backend deploy separately, and deliberately so.

| Component | Target | Why |
|---|---|---|
| `apps/tenant-web`, `apps/admin-web` | **Vercel** | Static Vite builds. Wildcard subdomains for per-tenant hosting. |
| `apps/api` | **Docker** — Render / Railway / VPS | Long-running process with a resident scheduler and persistent pg pools. Not serverless. |
| PostgreSQL | Managed (Render/Neon/Supabase) or self-hosted | RLS is the isolation boundary. Needs transaction-mode pooling if pooled. |

**The API is not adapted for serverless, and should not be.** It owns an
in-process reminder scheduler (`setInterval`) and two persistent connection
pools. On a serverless platform the scheduler would never run and concurrent
invocations would exhaust the connection limit. The existing `Dockerfile`
builds correctly and serves Render, Railway, and a plain VPS unchanged.

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

Then create the first superadmin. **Do not run `npm run seed` against
production** — it upserts the demo credentials published in the README, and
the guard will refuse anyway. Insert the row manually with a bcrypt hash.

## 2. API

### Render

`render.yaml` is a working blueprint. After the first deploy, set the two
`sync: false` variables by hand:

- `APP_DATABASE_URL` — the `app_user` connection string. Render cannot derive
  a non-owner role, and the database's own `connectionString` is the owner.
- `CORS_ORIGINS` — only needed if the SPAs are not proxied same-origin.

### Railway / VPS

Same image, same variables:

```bash
docker build -f apps/api/Dockerfile -t dentalcare-api .
docker run -p 3000:3000 --env-file .env.production dentalcare-api
```

### Required configuration

Copy `.env.production.example`. The API validates everything at boot and
**refuses to start** on a bad config rather than running unsafely:

| Variable | Failure if wrong |
|---|---|
| `APP_DATABASE_URL` | Missing → boot refused. Points at a superuser or `BYPASSRLS` role → boot refused. Either would silently disable RLS and expose every clinic's data to every other clinic. |
| `JWT_SECRET` | Missing, under 32 chars, or the `.env.example` placeholder → boot refused. |
| `DATABASE_URL` | Missing → boot refused. |
| `NODE_ENV` | Must be `production`. It disables the client-supplied tenant header and switches logging to JSON. |

## 3. Frontends

Two Vercel projects, both with **Root Directory** set to the repo root (the
build commands are workspace-aware).

Edit the API host in each `vercel.json` before deploying — Vercel does not
interpolate environment variables into rewrite destinations, so the value is
a literal:

```json
{ "source": "/api/:path*", "destination": "https://api.dentalcare.app/api/:path*" }
```

Proxying through the rewrite keeps the SPA and API same-origin, which means
`CORS_ORIGINS` can stay unset. If you point the SPA directly at the API host
instead, you must set it.

### Domains

- `admin-web` → `admin.dentalcare.app`
- `tenant-web` → `*.dentalcare.app` (wildcard)

The wildcard is what makes multi-tenancy work: the API reads the first label
of the `Host` header (`avicena.dentalcare.app` → `avicena`) and resolves it to
a tenant. Requires a wildcard DNS record and a wildcard TLS certificate.

`www` is explicitly not treated as a tenant.

---

## Scaling beyond one instance

**The API must currently run at exactly one replica.**

`ReminderSchedulerService` runs `setInterval` in-process with no distributed
lock. A second replica scans the same tenants concurrently. The partial unique
index `reminders_auto_unique` prevents duplicate rows, so this is not a
correctness disaster — each claim now runs in its own transaction and a
conflict is skipped cleanly — but it is wasted work and noisy logs.

To scale horizontally, extract the scheduler into a separate single-replica
worker or a platform cron job, then let the API scale freely. This is the
single highest-leverage structural change available and is tracked in
[`MASTER_REMEDIATION_PLAN.md`](MASTER_REMEDIATION_PLAN.md) (issue H6).

`render.yaml` pins `numInstances: 1` with this reason inline.

## Connection pooling

`withTenant()` sets `app.current_tenant_id` via `set_config(..., true)` —
**transaction-local**. If you put PgBouncer or any pooler in front of
Postgres it must run in **transaction mode**. Session or statement mode would
break tenant scoping, potentially leaking context between requests. This is a
subtle, high-consequence setting; verify it explicitly.

## Health, shutdown, logging

- `GET /api/health` — reports DB reachability. Wired as Render's health check
  and as the compose healthcheck.
- `enableShutdownHooks()` closes both pools and stops the scheduler on
  SIGTERM, so rolling deploys drain cleanly.
- Logs are JSON (pino) in production, with `x-request-id` correlation.
  `authorization` and `cookie` headers are redacted.

## Before first paying customer

- [ ] `NODE_ENV=production`, `JWT_SECRET` rotated off any shared value
- [ ] `APP_DATABASE_URL` verified — boot logs no RLS warning
- [ ] Automated backups enabled, **and a restore rehearsed**
- [ ] Wildcard DNS + TLS in place
- [ ] Superadmin created manually, not seeded
- [ ] Uptime and error alerting on `/api/health`
