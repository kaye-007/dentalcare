# DentalCare — Architecture & Production Readiness Audit

Describes the system as built.

> **Status.** Sections 1–5 remain accurate. Section 6 (Findings) and section 7
> (Vercel assessment) were written _before_ the `production-hardening` branch;
> most Critical and High findings there are now fixed. For current state see
> [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md), [`CHANGELOG.md`](CHANGELOG.md), and
> [`DEPLOYMENT.md`](DEPLOYMENT.md). Structure is catalogued in
> [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md).
>
> Section 7 is doubly stale: the platform is Cloudflare now, not Vercel, and
> the Vercel manifests have been deleted. See [`DEPLOYMENT.md`](DEPLOYMENT.md).
>
> This repository is a snapshot that diverges from another copy of the project.
> The cleanup report that recorded the divergence in detail was deleted in the
> 2026-08 documentation sweep, and the divergence has not been re-verified
> since — treat it as an open question, not a settled one.

---

## 1. What this system actually is

A **multi-tenant SaaS for dental clinics in Albania**, built as an npm-workspace
monorepo containing one API and two React SPAs. One shared deployment; each
clinic is a tenant reached by its own subdomain. Internal clinic-staff system
only — no patient portal, no public marketing site.

### Stack (verified against the code, not assumed)

| Layer       | Technology                                                     |
| ----------- | -------------------------------------------------------------- |
| API         | NestJS 10 (modular monolith), Express platform                 |
| Database    | PostgreSQL 16, raw SQL via `pg` — **no ORM**                   |
| Migrations  | `node-pg-migrate` (11 migrations, plain JS)                    |
| Isolation   | PostgreSQL **Row-Level Security**, `FORCE`d, per-request GUC   |
| Auth        | Self-issued JWT (`@nestjs/jwt`) + `bcryptjs`                   |
| Validation  | `class-validator` DTOs (requests), `zod` (environment)         |
| Logging     | `nestjs-pino` with request-id correlation and header redaction |
| Frontends   | React 18 + Vite 5 + react-router 6 + `lucide-react`, plain CSS |
| Local infra | Docker Compose (Postgres + Redis)                              |

> **There is no Firebase or Firestore anywhere in this repository.**
> A repository-wide search for `firebase` / `firestore` across every `.ts`,
> `.tsx`, `.js`, `.json` and `.md` file returns zero matches. Persistence,
> authentication and authorization are all PostgreSQL- and NestJS-native.

### Repository layout

```
dentalcare/
├── apps/
│   ├── api/          @dentalcare/api         — NestJS  (44 .ts files, ~4.0k LOC)
│   ├── tenant-web/   @dentalcare/tenant-web  — clinic SPA  :5173 (24 files)
│   └── admin-web/    @dentalcare/admin-web   — superadmin SPA :5174 (10 files)
├── infra/docker/         Dockerfile + compose (postgres, migrate, api)
├── tsconfig.base.json    shared strict TS config
└── package.json          workspace root + script aliases
```

Total application source: **~9,450 lines**. The codebase is small, consistent,
and unusually well-commented. There is no dead-file bloat.

---

## 2. The two planes

This is the single most important architectural idea in the system, and
everything else follows from it.

```
                    ┌────────────────── CLINIC PLANE ──────────────────┐
 avicena.host ─────▶│ TenantMiddleware → resolve_tenant(subdomain)     │
                    │ AsyncLocalStorage ctx → JwtAuthGuard → OwnerGuard│
                    │ DB: APP_DATABASE_URL (app_user, NOBYPASSRLS)     │
                    │ every query wrapped in withTenant() ────────────┐│
                    └─────────────────────────────────────────────────┼┘
                                                                      │
                                              SET LOCAL app.current_tenant_id
                                                                      │
                    ┌───────────────── PLATFORM PLANE ────────────────┼┐
 admin SPA ────────▶│ PlatformJwtGuard (scope: 'platform')            ││
                    │ DB: DATABASE_URL (privileged) — bypasses RLS    ││
                    │ cross-tenant: list / create / suspend + audit   ││
                    └─────────────────────────────────────────────────┼┘
                                                                      ▼
                                                             PostgreSQL + RLS
```

**Clinic plane** (`src/tenant/**`) — everything a clinic's own staff touches.
Runs as the non-superuser `app_user` role, so Row-Level Security genuinely
cannot be bypassed.

**Platform plane** (`src/platform/**`) — NODE X superadmin. Operates across all
tenants, therefore _must_ bypass RLS, therefore uses the privileged connection
and is reachable only behind `PlatformJwtGuard`.

### How tenant isolation is enforced (three independent layers)

1. **Middleware** resolves `Host` → subdomain → tenant via the `resolve_tenant`
   `SECURITY DEFINER` function (needed because the lookup must run _before_ any
   tenant context exists; it returns only `id` + `status` for the one subdomain
   asked about, so it leaks nothing).
2. **Database** — every one of the 14 tenant tables carries
   `ENABLE` + `FORCE ROW LEVEL SECURITY` and an identical `tenant_isolation`
   policy keyed on `current_setting('app.current_tenant_id')`. Verified table
   by table; coverage is complete, with no gaps.
3. **Token binding** — `JwtAuthGuard` rejects a token whose `tenantId` does not
   match the subdomain being addressed, so a valid token for clinic A is inert
   on clinic B's subdomain.

Services never hand-write `WHERE tenant_id = …` on reads; they rely on RLS.
This is only safe because layer 2 is complete — which it is.

### Permission model

Exactly two clinic roles: **`owner`** and **`frontdesk`**. `position`
(Dentist, Assistant, …) is descriptive free text and grants nothing.
`OwnerGuard` gates: treatments create/update, staff management, salary log,
expense deletion, settings writes, and all of reports.

---

## 3. Data model (17 tables)

**Tenant-scoped (RLS enforced):** `tenants`, `users`, `patients`,
`patient_notes`, `appointments`, `treatments`, `tooth_records`,
`clinic_settings`, `invoices`, `invoice_line_items`, `payments`, `expenses`,
`reminders`, `salary_payments`

**Platform-only (no RLS by design; `app_user` explicitly `REVOKE`d):**
`plans`, `platform_admins`, `audit_log`

Notable schema decisions, all sound:

- Money is **integer Lekë**, never floats.
- Invoice numbers are per-tenant sequential (`UNIQUE (tenant_id, seq)`).
- Teeth use **FDI numbering**, enforced by a `CHECK` constraint _and_ in code.
- At most one automatic reminder per appointment via a **partial unique index**
  — this is what makes the scheduler scan idempotent.
- Appointment overlap protection uses `tstzrange && tstzrange`.

---

## 4. Feature surface (all implemented and wired)

Patients · Appointments (day/week calendar, overlap protection) · Treatments
catalog · Odontogram + per-tooth medical records · Staff & payroll log ·
Invoices, partial payments, expenses · Owner-only reports · Reminders
(scheduler + manual + log) · Clinic settings · Superadmin tenant management
with audit log.

Reminders currently deliver through a **`LogChannel`** that writes to the
reminder log and server log — nothing is sent to patients, and the UI says so.
The `ReminderChannel` interface is the seam where SMS/email would plug in
without schema or UI changes.

---

## 5. Build status — verified, not assumed

All three workspaces compile clean from a cold build:

| Workspace                | Result                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| `@dentalcare/api`        | `nest build` — success, no errors                                |
| `@dentalcare/tenant-web` | `tsc -b && vite build` — 1594 modules, 276.77 kB (79.00 kB gzip) |
| `@dentalcare/admin-web`  | `tsc -b && vite build` — 1580 modules, 181.21 kB (57.86 kB gzip) |

TypeScript runs `strict` everywhere. There are zero `TODO`/`FIXME`/`HACK`
markers in the source.

---

## 6. Findings

Ordered by severity. Nothing here has been changed — this is the Phase 2 queue.

### HIGH — `archived` tenants retain full access

Migration `0004` redefined the tenant status set to
`('active','suspended','archived')`, dropping `'trial'` and `'cancelled'`.
But both gates still test the **old** values:

- `core/tenancy/tenant.middleware.ts:37` — `status === 'suspended' || status === 'cancelled'`
- `tenant/auth/auth.service.ts:47` — same pair

`'cancelled'` can no longer exist, and **`'archived'` is not checked at all**.
The admin SPA offers an explicit "Archive" button
(`admin-web/src/pages/TenantsPage.tsx:128`), so archiving a clinic today
revokes nothing — its staff keep logging in and using the system normally.

### HIGH — refresh tokens are issued but never used

The API issues a refresh token and exposes `POST /api/auth/refresh`, and
`tokenStore` persists it under `dc.refresh`. **No code ever reads it back.**
The only reference is the write in `lib/auth.tsx:50`. With
`JWT_ACCESS_TTL=15m`, every clinic user is hard-logged-out mid-work every 15
minutes with no silent renewal. The endpoint is effectively dead code from the
client's perspective.

### MEDIUM — `NODE_ENV` is a load-bearing security control

`TenantMiddleware.resolveSubdomain` honours a client-supplied
`X-Tenant-Subdomain` header (and the `DEV_TENANT_SUBDOMAIN` fallback) whenever
`NODE_ENV !== 'production'`. The tenant-web client sends that header on _every_
request, unconditionally.

Impact is bounded — token-to-tenant binding still blocks cross-tenant data
access, so this is tenant enumeration and credential probing against arbitrary
clinics, not a data leak. But it means **deploying with `NODE_ENV` unset or
`development` silently weakens tenant resolution.** Treat it as a deployment gate.

### MEDIUM — no rate limiting on either login endpoint

`POST /api/auth/login` and `POST /api/platform/auth/login` are unthrottled.
The superadmin endpoint in particular guards cross-tenant access.

### MEDIUM — `docker-compose` `api` service cannot boot

The `api` service sets no `JWT_SECRET` and has no `env_file:`, while
`.dockerignore` excludes `.env` from the image. `validateEnv` requires
`JWT_SECRET` (≥16 chars), so the container exits at startup. Unnoticed because
the README only ever starts `postgres` and `redis`. The Dockerfile itself is fine.

### LOW — migration `0003` interpolates the DB password into SQL

`CREATE ROLE … PASSWORD '${appPass}'` is built by string concatenation from
`APP_DB_PASSWORD`. Harmless with the dev default; a production password
containing a quote would break or alter the statement.

### LOW — Redis is provisioned but entirely unused

Declared in `infra/docker/docker-compose.yml`, validated in `env.validation.ts`, referenced
in a comment about a future BullMQ migration — and never imported by any
application code. Aspirational infrastructure.

### LOW — workspace declares a `packages/*` glob with no `packages/` directory

Harmless, but misleading about the repo's shape.

### LOW — cosmetic / inert

- The topbar search input (`AppLayout.tsx:170`) is decorative — no handler.
- `ui.tsx:30` still labels billing pills "sample widgets until M8"; M8 shipped.
- `dentalcare/` at the repo root contains only a stray `.gitattributes`.
- `.vscode/launch.json` is untracked and points at unused port 8080.

### Not defects — verified and intentional

- **Cross-plane token confusion is blocked.** A platform token has no
  `tenantId` so `JwtAuthGuard` rejects it; a clinic token has no
  `scope: 'platform'` so `PlatformJwtGuard` rejects it. Both directions checked.
- **RLS `WITH CHECK` on `tenants`.** The policy omits `WITH CHECK`; Postgres
  then reuses the `USING` expression for new rows, so this is safe, not a gap.
- **"Owner-only pricing"** in the README means _editing_ prices. Frontdesk can
  read the catalog by design, and `OwnerGuard` correctly covers write paths.
- **`outstanding` ignores the period filter** in both finance summary and
  reports. Correct: outstanding balance is point-in-time, not a period total.

### Engineering-practice gaps

No tests (zero spec files), no ESLint/Prettier config, no CI pipeline.

---

## 7. Vercel deployment assessment

**The two SPAs are a clean fit. The API is not.**

`apps/tenant-web` and `apps/admin-web` are static Vite builds and deploy to
Vercel as-is. Both call `/api/*` as a **same-origin relative path**, which
works locally only because of the Vite dev proxy — in production that needs a
rewrite, or the API must sit behind the same hostname.

The API resists Vercel's serverless model in four specific ways:

1. **In-process scheduler.** `ReminderSchedulerService` uses `setInterval` in
   `onModuleInit` (`reminders.module.ts:266`). Serverless functions do not stay
   resident, so automatic reminders would simply never fire. This needs to
   become a Vercel Cron route or an external worker. The scan is already
   idempotent, so the move is safe — but it _is_ a code change.
2. **Two persistent `pg.Pool`s** (max 10 + 5) created per instance. Serverless
   concurrency multiplies these and exhausts Postgres connections without a
   pooler (Supabase/Neon pgBouncer, or Prisma Accelerate-style proxy).
3. **The RLS design depends on transaction-scoped state.** `withTenant()` sets
   `app.current_tenant_id` via `set_config(..., true)` — transaction-local. That
   is correct and portable, but it _requires_ session/transaction pooling mode
   to behave, which constrains the pooler configuration.
4. **Wildcard subdomains per tenant.** Needs a wildcard domain
   (`*.dentalcare.app`) attached to the project, plus per-tenant DNS.

Realistic options, in order of how much they preserve today's behaviour:

- **Recommended — split the deployment.** SPAs on Vercel; API on a
  container host (Railway / Render / Fly / a VPS) using the existing Dockerfile,
  which already builds correctly. Zero architectural change; the scheduler keeps
  working exactly as designed.
- **All-Vercel.** Port the API to serverless functions, move the scheduler to
  Vercel Cron, and put a connection pooler in front of Postgres. Achievable, but
  it is a rework — not a packaging exercise.

Either way, the following must be settled before any production deploy:
`NODE_ENV=production`, a rotated `JWT_SECRET`, a real `APP_DATABASE_URL` (a
missing one silently disables RLS — `database.service.ts:33` warns but still
boots), managed Postgres with TLS, CORS widened beyond the current
`localhost`-only regex if the API is cross-origin, and security headers.

---

## 8. Assessment

This is a well-built codebase. The tenancy model is enforced in the database
rather than trusted to application code, the two planes are cleanly separated
with distinct credentials and guards, money is integers, the reminder scan is
idempotent by construction, and the comments explain _why_ rather than _what_.
It is genuinely production-shaped.

What stands between it and production is a short, specific list — the archived
-tenant gate, token refresh, login rate limiting, `NODE_ENV` discipline, and a
deployment target that can actually run a resident scheduler — not a rewrite.
