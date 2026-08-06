# DentalCare — Master Remediation Plan

**Phase 2.5 deliverable — full engineering review.**
No code was modified in producing this document.

Companion to [`ARCHITECTURE.md`](ARCHITECTURE.md), which describes the system as
built. This document validates each subsystem, categorises every defect,
evaluates deployment options, and sequences the work.

---

## Executive Summary

DentalCare is a genuinely well-architected multi-tenant SaaS. The central
design decision — enforcing tenant isolation in PostgreSQL via `FORCE ROW LEVEL
SECURITY` under a non-superuser role, rather than trusting application-layer
`WHERE` clauses — is the right one, and it is implemented completely and
consistently across all 14 tenant tables. The separation of the clinic plane
from the platform plane, each with its own database credentials, guard, and
token scope, is textbook. All three workspaces compile clean under `strict`
TypeScript.

It is not, however, production-ready. Review surfaced **two Critical and seven
High** issues. Two are of a kind that static reading does not reveal:

- **The seed script will silently reset production credentials.** It upserts
  `admin@nodex.al / Admin123!` with `ON CONFLICT … DO UPDATE SET password_hash`.
  Run once against a production `DATABASE_URL`, it overwrites the live
  superadmin password with a published default — granting cross-tenant access
  to anyone who has read the README.
- **`APP_DATABASE_URL` is optional, and omitting it disables tenant isolation
  entirely.** The service falls back to the privileged connection, logs a
  warning, and boots normally. Every RLS policy in the system is silently
  inert. A single missing environment variable converts a well-isolated system
  into one with none.

Two further defects are latent concurrency bugs that will not appear in
single-instance testing but will surface under the horizontal scaling that
"hundreds of clinics" implies: both the invoice-number retry and the reminder
scan attempt to recover from a unique-violation by continuing inside an
already-aborted transaction, which PostgreSQL rejects with `25P02`.

None of this requires a rewrite. The remediation is roughly **three focused
weeks** of work against a sound foundation.

### Scorecard

| Dimension | Score | Basis |
|---|---|---|
| **Architecture** | **8 / 10** | Excellent tenancy and plane separation. Loses points for the scheduler being coupled to the API process, and for I/O side effects inside DB transactions. |
| **Security** | **6 / 10** | RLS and token-binding are above average. Offset by two Critical config-driven failures, no password management, and no rate limiting. |
| **Deployment** | **4 / 10** | Dockerfile builds correctly, but `docker-compose` cannot boot the API, CORS is localhost-only, no CI, no backups, target undecided. |
| **Maintainability** | **6 / 10** | Very readable, consistent, well-commented. Zero tests, no linter, no CI. |
| **Performance** | **7 / 10** | Strong index coverage, integer money, no N+1 patterns. Four round trips per request; unpaginated lists; untrigrammed search. |
| **Production Readiness** | **5 / 10** | Core is sound and builds clean; the Critical and High items are genuine blockers. |

**Overall: 6.0 / 10** — a strong foundation with a short, specific list of
blockers. Not shippable today; credibly shippable in three weeks.

---

## 1. Subsystem Validation

| # | Subsystem | Verdict |
|---|---|---|
| 1 | Authentication flow | **Needs Refactoring** |
| 2 | Authorization | **Production Ready** |
| 3 | Multi-tenant isolation | **Needs Minor Improvements** |
| 4 | Tenant resolution | **Needs Minor Improvements** |
| 5 | RLS implementation | **Production Ready** |
| 6 | PostgreSQL transaction flow | **Needs Refactoring** |
| 7 | Platform vs Clinic separation | **Production Ready** |
| 8 | JWT lifecycle | **Needs Refactoring** |
| 9 | Refresh token lifecycle | **Requires Architectural Changes** |
| 10 | Background jobs | **Requires Architectural Changes** |
| 11 | Reminder scheduling | **Requires Architectural Changes** |
| 12 | Docker architecture | **Needs Minor Improvements** |
| 13 | Deployment assumptions | **Requires Architectural Changes** |

### 1.1 Authentication flow — Needs Refactoring

Login is correct in itself: `bcrypt.compare` with cost 10, a single shared
`UnauthorizedException` for both unknown-user and bad-password (no user
enumeration), user-status and tenant-status checks after credential
verification, and the lookup scoped through `withTenant` so RLS applies.

What is missing is everything around it. **There is no password change endpoint,
no password reset, and no forgot-password flow anywhere in the codebase** — a
grep across the API for password handling returns only login and the initial
`bcrypt.hash` in staff creation. Staff are created with an owner-chosen
temporary password that can then never be rotated by anyone, including the
person using it. For a system holding medical records this is a significant gap,
not a missing nicety.

There is also no rate limiting on either login endpoint, no account lockout, and
no failed-attempt logging.

### 1.2 Authorization — Production Ready

Two roles, `owner` and `frontdesk`, with `position` explicitly documented and
implemented as descriptive-only. `OwnerGuard` runs after `JwtAuthGuard` and
reads the verified payload. Server-side enforcement was checked against every
client-side gate: reports, staff writes, salary log, settings writes, treatment
writes, and expense deletion are all guarded on the server, not merely hidden in
the UI. `StaffService.list` correctly strips payroll fields for non-owners
rather than relying on the client. Self-demotion and self-disable are blocked.

The one thing worth recording: the "owner-only pricing" phrasing in the README
means *editing* prices. Frontdesk reads the catalog by design. This is
consistent between guard, service, and UI — not a defect.

### 1.3 Multi-tenant isolation — Needs Minor Improvements

Three independent layers, verified individually:

1. RLS on all 14 tenant tables (`ENABLE` + `FORCE`, identical policy).
2. The runtime role is `NOSUPERUSER … NOBYPASSRLS`, so the policies cannot be
   sidestepped.
3. `JwtAuthGuard` rejects a token whose `tenantId` differs from the resolved
   subdomain, so a valid clinic-A token is inert on clinic B.

Cross-plane token confusion was checked in both directions and is blocked: a
platform token carries no `tenantId` (rejected by `JwtAuthGuard`), and a clinic
token carries no `scope: 'platform'` (rejected by `PlatformJwtGuard`).

The rating is not "Production Ready" for one reason: the whole edifice rests on
`APP_DATABASE_URL` being set, and the code treats it as optional (issue **C2**).

### 1.4 Tenant resolution — Needs Minor Improvements

`resolve_tenant` is a well-judged piece of design: `SECURITY DEFINER` with a
pinned `search_path`, `REVOKE ALL … FROM PUBLIC`, granted only to `app_user`,
returning only `id` and `status` for the single subdomain queried. It solves the
genuine chicken-and-egg problem of needing a tenant lookup before tenant context
exists, without opening a hole.

The weakness is that `NODE_ENV` is load-bearing (issue **H7**): when it is
anything other than `production`, a client-supplied `X-Tenant-Subdomain` header
selects the tenant, and the SPA sends that header unconditionally on every
request.

### 1.5 RLS implementation — Production Ready

The strongest part of the system. Coverage was confirmed table by table rather
than inferred from the migration comments. Platform tables (`platform_admins`,
`audit_log`) are explicitly `REVOKE`d from `app_user` in migration `0004`, which
is the correct complement to leaving them un-policied.

One point worth recording so it is not "fixed" later by mistake: the `tenants`
policy declares `USING` without `WITH CHECK`. This is safe — PostgreSQL reuses
the `USING` expression as the check for new rows when `WITH CHECK` is omitted.

### 1.6 PostgreSQL transaction flow — Needs Refactoring

`withTenant` → `withTransaction` is clean: `BEGIN`, transaction-local
`set_config(..., true)`, callback, `COMMIT`/`ROLLBACK`, `release()` in `finally`.
Connections are correctly released on every path.

Two problems:

**The retry-on-conflict logic cannot work** (issues **H5**, **H6**). Both
`FinanceService.createInvoice` and `RemindersService.scanTenant` catch a `23505`
unique violation and `continue` the loop — but the failing statement has already
aborted the enclosing transaction, so the next statement fails with `25P02`
(*current transaction is aborted*). Because `25P02 !== 23505`, the handler
rethrows. The net effect is that a recoverable conflict becomes an opaque 500,
and the retry is dead code. Correct fixes are a `SAVEPOINT` around the
conflicting statement, or retrying the whole transaction from outside.

**Every read costs four round trips** (issue **M12**): `BEGIN`, `set_config`,
the query, `COMMIT`. Correct and portable, but 4× the latency of a plain query,
which is material on a cross-region database.

### 1.7 Platform vs Clinic separation — Production Ready

Separate connection pools, separate credentials, separate guards, separate token
scopes, separate route namespace (`/api/platform/*`), and platform routes
excluded from `TenantMiddleware`. Platform mutations are wrapped in
`withAdminTransaction` with the audit write inside the same transaction, so an
action and its audit record commit atomically. This is done properly.

The code documents that the platform plane reuses the migration superuser as an
MVP shortcut and that a dedicated least-privilege role belongs in production —
an accurate self-assessment.

### 1.8 JWT lifecycle — Needs Refactoring

Signing and verification are correct, `type`/`scope` claims are checked, and the
tenant-binding check is a genuinely good idea.

Gaps: no `jti`, no revocation list, no key rotation strategy, and a **single
`JWT_SECRET` shared between the clinic and platform planes** — a leak
compromises both at once. Logout is purely client-side (`localStorage.clear()`),
so an exfiltrated token remains valid for its full TTL. Tokens live in
`localStorage` and are therefore XSS-reachable.

### 1.9 Refresh token lifecycle — Requires Architectural Changes

Effectively non-existent. The token is minted, returned, and written to
`localStorage` — and never read again. `POST /api/auth/refresh` is live but no
client calls it. There is no rotation, no server-side storage, no revocation,
and no reuse detection; a stolen refresh token is valid for its full seven days
with no way to invalidate it.

The user-visible consequence is that every clinic user is hard-logged-out every
15 minutes, mid-task.

This needs designing, not patching: silent refresh on 401, rotation on use,
server-side storage keyed by `jti`, and reuse detection.

### 1.10 Background jobs — Requires Architectural Changes

There is exactly one: `ReminderSchedulerService`, a `setInterval` started in
`onModuleInit`, living inside the API process. For a single-VPS MVP this is a
defensible choice and the code says so.

It does not survive either direction of change. On serverless it never runs at
all. On more than one instance, every replica scans every tenant concurrently —
the partial unique index prevents duplicate *rows*, but only by raising the
`23505` that issue **H6** shows is mishandled, so concurrent scans produce
failed scans rather than clean skips. There is no distributed lock, no leader
election, and no `SELECT … FOR UPDATE SKIP LOCKED` claim pattern.

### 1.11 Reminder scheduling — Requires Architectural Changes

The domain design is good: idempotency enforced by a partial unique index rather
than by application checks, a clean `ReminderChannel` seam, and honest UI about
the log-only channel.

The delivery mechanism has a flaw that is harmless today and serious tomorrow
(issue **M1**). `deliver()` performs `channel.send()` **inside the tenant
transaction**, between the `INSERT` and the status `UPDATE`. With the current
`LogChannel` that is fine. The moment a real SMS or email provider is plugged
into that same interface — which is the entire point of the abstraction — two
things break: a network call holds a database connection open for its full
duration (up to 100 per transaction), and any later rollback undoes the database
row *after* the message has already left. That is duplicate-send-on-retry, the
classic dual-write failure.

The correct shape is to commit the row first, then deliver outside the
transaction, then record the outcome in a second short transaction.

### 1.12 Docker architecture — Needs Minor Improvements

The API `Dockerfile` is well constructed: multi-stage, `--omit=dev` at runtime,
only `dist` copied forward, `NODE_ENV=production` set. It builds correctly.

`docker-compose.yml` is weaker. The `api` service supplies no `JWT_SECRET` and
declares no `env_file:`, while `.dockerignore` excludes `.env` from the image —
so `validateEnv` rejects the config and the container exits immediately (issue
**M2**). This has gone unnoticed because the README only ever starts `postgres`
and `redis`. Also missing: a `HEALTHCHECK`, a non-root `USER`, a pinned base
image digest, and a `redis` service that nothing consumes.

### 1.13 Deployment assumptions — Requires Architectural Changes

Both SPAs call `/api/*` as a **same-origin relative path**, which works locally
only because of the Vite dev proxy. Nothing in the repository establishes that
path in production: no `vercel.json`, no rewrite rules, no reverse-proxy config,
no deployment manifest of any kind. The API's CORS allowlist is
`/^http:\/\/localhost:\d+$/` — no production origin will pass it.

Additionally required and absent: wildcard DNS and a wildcard TLS certificate
for per-tenant subdomains, a documented backup policy, monitoring, and CI.
See §3.

---

## 2. Issue Register

Severity: **Critical** (blocks deploy; data loss or breach) · **High** (blocks
production use) · **Medium** (fix before scale) · **Low** (hygiene).
Risk = risk of *implementing the fix*. Time = one competent engineer.

### CRITICAL

---

**C1 — Seed script can reset production credentials**
`apps/api/scripts/seed.js`

- **Category:** Security
- **Impact:** Running `npm run seed` against a production database rewrites the
  live superadmin password to the README-published `Admin123!`, and every demo
  clinic owner/frontdesk password likewise. The superadmin can list, create, and
  suspend every tenant. This is full cross-tenant compromise via a single
  routine command, and it is *silent* — the upsert succeeds and prints "Seed
  complete."
- **Root cause:** The script has no environment guard, and uses
  `ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash`
  rather than `DO NOTHING`. It reads `DATABASE_URL` from the repo-root `.env`
  with no confirmation of which database that points at.
- **Fix:** Refuse to run when `NODE_ENV === 'production'`; require an explicit
  `ALLOW_SEED=1`; print the target host and database and require interactive
  confirmation; change credential upserts to `DO NOTHING` so re-seeding never
  rewrites an existing password.
- **Risk:** Very low — additive guards, dev-only script.
- **Time:** 1–2 h

---

**C2 — `APP_DATABASE_URL` is optional; omitting it disables all tenant isolation**
`apps/api/src/core/config/env.validation.ts:17`, `apps/api/src/core/database/database.service.ts:31-38`

- **Category:** Security / Deployment
- **Impact:** When unset, the tenant pool falls back to the privileged
  `DATABASE_URL`. That role is the migration superuser, which **bypasses RLS
  unconditionally** — including `FORCE`. Since services deliberately never write
  `WHERE tenant_id = …` and rely entirely on RLS, every tenant query silently
  returns *all tenants' rows*. Any clinic user would see every other clinic's
  patients, medical records, and finances. The app logs a warning and boots
  normally.
- **Root cause:** Marked `.optional()` in the Zod schema to keep local dev
  frictionless; the fallback trades a hard failure for a log line. In
  development that is convenient; in production it is catastrophic, and nothing
  distinguishes the two.
- **Fix:** Make `APP_DATABASE_URL` **required when `NODE_ENV === 'production'`**
  via a Zod `superRefine`. Additionally, assert at boot that the runtime role is
  not a superuser and does not have `rolbypassrls`
  (`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`),
  and refuse to start if it is. This turns the most dangerous
  misconfiguration in the system into a startup crash.
- **Risk:** Low — fails fast and loudly; the check is a few lines.
- **Time:** 2–3 h

---

### HIGH

---

**H1 — `archived` tenants retain full access**
`apps/api/src/core/tenancy/tenant.middleware.ts:37`, `apps/api/src/tenant/auth/auth.service.ts:47`

- **Category:** Security
- **Impact:** The admin SPA's "Archive" action revokes nothing. Archived
  clinics' staff keep logging in and using the system indefinitely — including,
  presumably, clinics archived for non-payment.
- **Root cause:** Migration `0004` redefined the status set from
  `('trial','active','suspended','cancelled')` to
  `('active','suspended','archived')`. Both gates were left checking the old
  values. `'cancelled'` is now unreachable; `'archived'` is unchecked.
- **Fix:** Gate on an allowlist — permit only `'active'` — rather than a
  denylist of known-bad values, so future status additions fail closed. Align
  the `AuthUserRow.tenant_status` union with the real constraint.
- **Risk:** Low. Verify no seeded/live tenant sits in an unexpected status first.
- **Time:** 1 h

---

**H2 — No password change, reset, or forgot-password anywhere**
API-wide

- **Category:** Security / UX
- **Impact:** A staff member's initial owner-chosen password can never be
  rotated by anyone. Compromised credentials cannot be remediated except by an
  owner disabling the account. There is no self-service recovery, so a forgotten
  owner password requires direct database access.
- **Root cause:** Not implemented; not in the milestone list.
- **Fix:** `PATCH /api/auth/password` (current + new, re-verify current,
  invalidate outstanding refresh tokens). Owner-initiated staff password reset.
  Optionally a `must_change_password` flag on first login. Email-based reset
  requires a mail provider and can follow.
- **Risk:** Low–medium — new endpoints, no changes to existing behaviour.
- **Time:** 1–1.5 d (2–3 d with email reset)

---

**H3 — Refresh token issued and stored but never used**
`apps/tenant-web/src/lib/auth.tsx:50`, `apps/tenant-web/src/lib/api.ts:8`

- **Category:** UX / Authentication
- **Impact:** Every clinic user is hard-logged-out every 15 minutes, losing
  in-progress work. In a clinic reception workflow this is severe. A working
  `/api/auth/refresh` endpoint sits unused.
- **Root cause:** Client-side refresh interception was never built.
- **Fix:** Wrap `request()` so a 401 triggers a single refresh attempt and
  replays the original request, with concurrent 401s sharing one in-flight
  refresh promise. Combine with **H8** (rotation) rather than shipping
  separately.
- **Risk:** Medium — touches every API call; needs care around retry loops and
  refresh stampedes.
- **Time:** 1 d

---

**H4 — No rate limiting on either login endpoint**
`/api/auth/login`, `/api/platform/auth/login`

- **Category:** Security
- **Impact:** Unlimited credential stuffing. The platform endpoint guards
  cross-tenant access, so it is the higher-value target. Combined with **H7**,
  an attacker can also probe credentials against any clinic they can name.
- **Root cause:** No throttling layer; `@nestjs/throttler` is not a dependency.
- **Fix:** Add `@nestjs/throttler` with a strict per-IP-plus-email limit on both
  login routes and a looser global default. Log failed attempts. Consider
  progressive backoff or lockout after repeated failures.
- **Risk:** Low — additive. Ensure the real client IP is read correctly behind
  a proxy (`trust proxy`).
- **Time:** 3–4 h

---

**H5 — Invoice-number retry runs inside an aborted transaction**
`apps/api/src/tenant/finance/finance.module.ts:220-247`

- **Category:** Reliability
- **Impact:** Two users in the same clinic creating invoices simultaneously: one
  hits `23505` on `invoices_tenant_seq_unique`, the retry immediately fails with
  `25P02`, and the user receives an opaque 500 instead of a successfully
  numbered invoice. The documented retry never functions.
- **Root cause:** In PostgreSQL, any error inside a transaction block aborts it;
  all subsequent commands fail until `ROLLBACK` or `ROLLBACK TO SAVEPOINT`. The
  loop retries *inside* the same transaction opened by `withTenant`.
- **Fix:** Wrap the insert in a `SAVEPOINT` and `ROLLBACK TO SAVEPOINT` before
  retrying — or, cleaner, replace max-seq scanning with a per-tenant sequence
  allocation (an `invoice_counters` row updated with `UPDATE … RETURNING`, which
  serialises correctly under concurrency without retry logic).
- **Risk:** Medium — touches invoice creation, a financial path. Needs a
  concurrency test.
- **Time:** 4–6 h

---

**H6 — Reminder scan mishandles conflicts; scheduler is not multi-instance safe**
`apps/api/src/tenant/reminders/reminders.module.ts:198-202`, `:264-268`

- **Category:** Reliability / Architecture
- **Impact:** Identical `25P02` defect as **H5**: the `continue` on `23505` runs
  in an aborted transaction, so the whole tenant scan throws and rolls back —
  discarding reminders already created in that pass. Today this can only trigger
  with two or more API instances, because a single instance is protected by the
  `running` flag. It therefore becomes a live bug the moment the API is scaled
  horizontally — the same step required to serve hundreds of clinics.
- **Root cause:** In-process `setInterval` scheduler with no distributed lock or
  work-claiming, plus the aborted-transaction retry pattern.
- **Fix:** Two parts. (a) Correct the conflict handling (`SAVEPOINT`, or claim
  rows with `SELECT … FOR UPDATE SKIP LOCKED`). (b) Extract the scheduler from
  the API into a single-replica worker or a platform cron that calls an
  authenticated internal endpoint — see §3. Until then, pin the API to one
  replica and document it as a constraint.
- **Risk:** Medium–high — changes how reminders are delivered. Needs a staging
  soak.
- **Time:** 2–3 d (including extraction)

---

**H7 — `NODE_ENV` is a load-bearing tenant-resolution control**
`apps/api/src/core/tenancy/tenant.middleware.ts:56-65`

- **Category:** Security / Deployment
- **Impact:** Whenever `NODE_ENV !== 'production'`, a client-supplied
  `X-Tenant-Subdomain` header chooses the tenant, falling back to
  `DEV_TENANT_SUBDOMAIN`. The tenant SPA sends that header on **every** request,
  unconditionally. Token-to-tenant binding still prevents cross-tenant data
  access, so the direct impact is tenant enumeration and credential probing
  against arbitrary clinics rather than a data leak — but a deployment that
  forgets one environment variable quietly weakens the front door.
- **Root cause:** Development convenience (no hosts-file editing) gated on an
  environment variable that is easy to get wrong and fails open.
- **Fix:** Gate the header on an explicit, separate `ALLOW_TENANT_HEADER=1`
  rather than on the negation of `NODE_ENV`, and refuse to honour it when
  `NODE_ENV === 'production'` regardless. Fail closed.
- **Risk:** Low — but coordinate with the SPA, which sends the header always.
- **Time:** 2–3 h

---

### MEDIUM

| ID | Issue | Category | Impact | Root cause | Fix | Risk | Time |
|---|---|---|---|---|---|---|---|
| **M1** | `channel.send()` executed inside the tenant transaction | Architecture | Harmless with `LogChannel`; with a real SMS/email provider a network call holds a DB connection (up to 100/txn) and a rollback undoes the row *after* the message was sent → duplicate sends. Undermines the channel abstraction's whole purpose. | Dual-write: side effect and state change in one transaction | Commit the row, deliver outside the transaction, record outcome in a second short transaction | Medium | 1 d |
| **M2** | `docker-compose` `api` service cannot boot | Deployment | Container exits at startup; `docker compose up` is not a working path | No `JWT_SECRET`/`env_file:`; `.dockerignore` excludes `.env` | Add `env_file: .env`; add `HEALTHCHECK`, non-root `USER`, `depends_on` for redis if retained | Very low | 1–2 h |
| **M3** | CORS allowlist is localhost-only | Deployment | Any cross-origin production deployment is blocked outright | `origin: [/^http:\/\/localhost:\d+$/]` hardcoded | Drive from a `CORS_ORIGINS` env var; support the wildcard-subdomain pattern | Low | 2 h |
| **M4** | No security headers | Security | No HSTS, CSP, `X-Content-Type-Options`, frame protection | `helmet` not installed | Add `helmet` with a CSP suited to the SPAs | Low | 2–3 h |
| **M5** | One `JWT_SECRET` for both planes | Security | A single leak compromises clinic *and* platform planes together | Shared config key | Split into `JWT_SECRET` and `PLATFORM_JWT_SECRET` | Low | 2 h |
| **M6** | No refresh rotation, revocation, or server-side logout | Security | A stolen refresh token is valid 7 days with no way to revoke; logout only clears `localStorage` | Stateless-only design | Persist refresh tokens by `jti`; rotate on use; detect reuse; real logout endpoint | Medium | 1–1.5 d |
| **M7** | Tokens in `localStorage` | Security | XSS-reachable | Simplicity | Acceptable if CSP is strong; otherwise httpOnly refresh cookie + in-memory access token | Medium | 1 d |
| **M8** | No global exception filter | Maintainability | Inconsistent error shapes; unhandled PG errors surface as bare 500s | Not implemented | Global filter mapping PG codes to HTTP, uniform envelope, request-id correlation | Low | 4 h |
| **M9** | No tests, no linter, no CI | Maintainability | No regression safety net for any fix in this plan | Never set up | ESLint + Prettier; Jest + Supertest; GitHub Actions running build + tests. **Prioritise RLS isolation tests.** | Low | 2–3 d |
| **M10** | Migration `0003` interpolates the DB password into SQL | Security / Reliability | A production password containing a quote breaks or alters `CREATE ROLE` | String concatenation in `pgm.sql` | Use `format('%L')` or `quote_literal`; document the constraint | Low | 1 h |
| **M11** | Unpaginated list endpoints | Performance | Hard caps (`200`/`300`/`500`) silently truncate; an established clinic will exceed them and see incomplete data with no indication | Only `patients` paginates | Extend the `patients` pagination pattern to invoices, payments, expenses, appointments, reminders | Low | 1 d |
| **M12** | Four round trips per tenant request | Performance | `BEGIN` + `set_config` + query + `COMMIT`; ~4× a plain query's latency, material cross-region | RLS design requires transaction-local GUC | Combine `BEGIN`/`set_config` into one round trip; co-locate API and DB. Do **not** switch to session-scoped GUC under a pooler | Low | 4 h |
| **M13** | Patient search uses `ILIKE '%…%'` with no trigram index | Performance | Sequential scan per keystroke-search; degrades as clinics grow | No `pg_trgm` | `CREATE EXTENSION pg_trgm` + GIN indexes on searched columns | Low | 3 h |
| **M14** | PII written to application logs | Security / Compliance | `LogChannel` logs patient name, appointment time, and reason to server logs; log stores rarely carry health-data controls | Convenience logging in the MVP channel | Log the reminder id and outcome, not the rendered body | Low | 1 h |
| **M15** | No clinic-plane audit trail | Compliance | `audit_log` covers platform actions only. No record of who read or altered a medical record or invoice — commonly expected for health data | Out of MVP scope | Append-only audit table for medical-record and financial mutations, minimally | Medium | 2–3 d |

### LOW

| ID | Issue | Category | Fix | Risk | Time |
|---|---|---|---|---|---|
| **L1** | Redis provisioned and validated but never used | Maintainability | Remove, or adopt for throttling/queues (see §5) | Very low | 30 m |
| **L2** | `packages/*` workspace glob with no `packages/` directory | Maintainability | Remove the glob or create the directory | Very low | 5 m |
| **L3** | Topbar search input is inert | UX | Wire to patient search, or remove until built | Very low | 2 h |
| **L4** | Stale comment: "sample widgets until M8" (`ui.tsx:30`) | Maintainability | Update — M8 shipped | Very low | 5 m |
| **L5** | Stray root `dentalcare/` holding only `.gitattributes` | Maintainability | Move `.gitattributes` to root; remove directory | Very low | 10 m |
| **L6** | `.vscode/launch.json` untracked, targets unused port 8080 | Maintainability | Correct to 5173, or gitignore `.vscode/` | Very low | 5 m |
| **L7** | No documented backup, restore, or monitoring | Reliability | Automated PITR backups; **test a restore**; uptime and error alerting | Low | 1 d |
| **L8** | `SettingsService.update` re-opens a transaction via `get()` | Performance | Return the updated row from the same transaction | Very low | 1 h |

**Totals — 2 Critical · 7 High · 15 Medium · 8 Low = 32 issues.**

---

## 3. Deployment Strategy

All options assume both SPAs on Vercel except **D** and **E**. The decisive
question is where a stateful NestJS process with a resident scheduler and two
persistent `pg` pools can live.

### Option A — Vercel + Docker VPS

| | |
|---|---|
| **Code changes** | Minimal: CORS origins, `NODE_ENV`, SPA API base URL. Existing Dockerfile builds unchanged. Scheduler works as designed. |
| **Infra changes** | VPS, Docker, reverse proxy (Caddy/nginx), wildcard TLS, Postgres (self-hosted or managed), backups, monitoring, OS patching, firewall |
| **Cost** | $10–40/mo VPS; +$0 self-hosted PG, or +$20–50 managed |
| **Scalability** | Vertical only without work; horizontal needs a load balancer and **H6** resolved |
| **Security** | Full control; full responsibility. You own CVE patching and DB hardening |
| **Reliability** | Single point of failure unless deliberately made redundant. Self-hosted PG without tested restores is the real risk |
| **Ops complexity** | **Highest.** Assumes someone owns Linux, Postgres, and TLS operationally |
| **Verdict** | Cheapest at scale, correct if you have ops capacity. Poor fit for a small team shipping features |

### Option B — Vercel + Railway

| | |
|---|---|
| **Code changes** | Minimal — same as A. Railway builds the Dockerfile natively |
| **Infra changes** | Railway project, managed Postgres, custom/wildcard domain, env vars |
| **Cost** | ~$5–20/mo API + ~$10–20 Postgres; usage-based |
| **Scalability** | Easy vertical; horizontal replicas available — **but only after H6** |
| **Security** | Managed patching, TLS, private DB networking |
| **Reliability** | Good. Managed backups. Historically more variable than Render/Fly |
| **Ops complexity** | **Low** |
| **Verdict** | Strong, pragmatic choice. Fastest path from here to production |

### Option C — Vercel + Render

| | |
|---|---|
| **Code changes** | Minimal — same as A/B |
| **Infra changes** | Render Web Service (Docker), managed Postgres, wildcard domain (paid tier) |
| **Cost** | ~$7–25/mo API + ~$7–20 Postgres. **Avoid the free tier** — it spins down, which kills the scheduler |
| **Scalability** | Vertical plus horizontal replicas; **native Background Workers and Cron Jobs** |
| **Security** | Comparable to B |
| **Reliability** | Good; managed PITR backups |
| **Ops complexity** | **Low** |
| **Verdict** | Marginally ahead of B for this codebase, because native Cron Jobs and Background Workers give **H6** a first-class home rather than a workaround |

### Option D — Everything on Firebase

| | |
|---|---|
| **Code changes** | **Total backend rewrite.** Firestore is a document store: no SQL, no RLS, no `pg`. Every one of the 11 migrations, all raw SQL, the entire RLS isolation model, and NestJS itself would be replaced by Firestore collections, Security Rules, and Cloud Functions |
| **Infra changes** | Entire platform migration; data export/transform |
| **Cost** | Unpredictable — per-document reads punish the list-heavy screens this app is built from |
| **Scalability** | High for simple access patterns; poor for this workload |
| **Security** | Security Rules are real but **weaker than DB-enforced RLS** — they are application-layer policy, not engine-enforced, and cannot express the current model as cleanly |
| **Reliability** | High |
| **Ops complexity** | Low once migrated; the migration itself is the risk |
| **Verdict** | **Strongly not recommended.** The domain is intrinsically relational — invoices → line items → payments, appointments → patients → staff, per-tooth records. Firestore cannot express the reporting aggregations (`SUM`/`GROUP BY` over date ranges, `generate_series` monthly trends) without BigQuery export or maintained rollups. This would discard the system's single greatest asset — database-enforced tenant isolation — in exchange for nothing. Estimated 6–12 weeks to reach parity, with a near-certain regression in isolation guarantees |

### Option E — Everything on Vercel

| | |
|---|---|
| **Code changes** | **Significant.** NestJS wrapped as a serverless handler; scheduler removed and rebuilt on Vercel Cron; connection strategy reworked for serverless |
| **Infra changes** | Serverless Postgres with a pooler (Neon/Supabase) is mandatory — two persistent pools per instance × N concurrent invocations exhausts connections immediately |
| **Cost** | Vercel Pro ~$20/mo + database. Function invocation costs scale with traffic |
| **Scalability** | Excellent request-level autoscaling; the DB connection layer is the binding constraint |
| **Security** | Good defaults. Note the transaction-local `set_config` **requires transaction-mode pooling** to remain correct — a misconfigured pooler could leak tenant context between requests. This is a subtle, high-consequence footgun |
| **Reliability** | High for requests; cold starts add latency. Cron minimum interval is 1 minute on Pro (adequate) |
| **Ops complexity** | Low, *after* a non-trivial migration |
| **Verdict** | Viable but the most code change of any option that keeps the stack. Adopting it now means rebuilding the scheduler and revalidating tenant isolation under a pooler — during the same window as fixing two Critical issues. Wrong sequencing |

### Recommendation

**Ship on Option C (Vercel + Render).** Option B is close enough that pricing or
existing familiarity can decide it; both preserve the Dockerfile and the
isolation model without code change, which matters while the Critical items are
still open.

**For hundreds of clinics**, the architecture I would actually deploy:

```
  Vercel ─────────► tenant-web  (wildcard *.dentalcare.app)
                    admin-web   (admin.dentalcare.app)
                          │
                          │  /api/*  → rewrite
                          ▼
  Render / Railway ─► API container  (2–4 stateless replicas)
                          │
                          ├─► Scheduler Worker  (exactly 1 replica)
                          │     └─ reminder scan only
                          │
                          ▼
  Neon / Supabase ──► PostgreSQL (primary + read replica)
                      PgBouncer (transaction mode)
                      PITR backups + tested restore
```

Rationale, in the order the decisions matter:

1. **Keep PostgreSQL and keep RLS.** Database-enforced isolation is this
   system's strongest security property. Hundreds of clinics in a shared schema
   with `FORCE` RLS is a proven pattern that scales well past this target.
2. **Extract the scheduler into its own single-replica service.** This resolves
   **H6** by construction rather than by distributed locking — one process owns
   the scan, so the concurrency bug cannot occur, and API replicas become freely
   scalable. This is the single highest-leverage structural change in the plan.
3. **Managed Postgres with a transaction-mode pooler.** Preserves
   `set_config(..., true)` semantics exactly while removing the connection
   ceiling.
4. **Frontends on Vercel.** Genuinely the right tool for static SPAs, with
   wildcard-subdomain support the tenancy model needs.

Hundreds of clinics is roughly 1,500–2,500 users and modest concurrency. The
constraint is not raw throughput — it is operational maturity: backups that have
been restored, alerting, and a scheduler with exactly one owner.

---

## 4. Technical Debt Prioritisation

Each phase is independently shippable. Phases 1–4 are the production gate.

### Phase 1 — Critical production blockers · ~1 day
`C1` seed guard · `C2` require `APP_DATABASE_URL` + assert non-superuser role ·
`H1` archived-tenant gate
> Nothing else matters until these three land. C1 and C2 are each sufficient on
> their own to compromise every tenant.

### Phase 2 — Security · ~2–3 days
`H4` login rate limiting · `H7` fail-closed tenant header · `M4` helmet ·
`M5` split JWT secrets · `M10` migration password quoting · `M14` PII out of logs
> Hardening that neither changes behaviour nor blocks other work.

### Phase 3 — Authentication · ~3–4 days
`H2` password change/reset · `H3` silent refresh · `M6` rotation, revocation,
real logout · `M7` decide the token-storage posture
> Treat as one workstream: refresh, rotation, and password change all touch the
> same token lifecycle and should be designed once.

### Phase 4 — Deployment · ~3–4 days
Choose target (§3) · `M3` CORS from env · `M2` fix `docker-compose` ·
Vercel rewrites + wildcard DNS/TLS · `L7` backups **with a tested restore** ·
monitoring · `M9` CI running build and tests
> Ends with a working staging environment. Do not skip the restore test.

### Phase 5 — Reliability & Performance · ~4–5 days
`H5` invoice numbering · `H6` scheduler extraction + conflict handling ·
`M1` deliver outside the transaction · `M11` pagination · `M13` `pg_trgm` ·
`M12` round-trip reduction
> `H5`/`H6`/`M1` are prerequisites for horizontal scaling *and* for connecting a
> real SMS provider. Sequence before any growth push.

### Phase 6 — Code cleanup · ~1 day
`L1` Redis decision · `L2` workspace glob · `L4` stale comment · `L5` stray
directory · `L6` `.vscode` · §5 confirmed-dead items
> Only after Phases 1–5, so cleanup is never confused with a behaviour change.

### Phase 7 — Refactoring · ~3–5 days
Split controllers/services/DTOs out of `*.module.ts` into conventional NestJS
files · extract the repeated `tx()` / column-map / `map()` helpers into a shared
base · `M8` global exception filter · align `AuthUserRow` types with real DB
constraints
> Deliberately late. The current file layout is unconventional but coherent and
> well-commented; churning it before tests exist trades real risk for style.

### Phase 8 — Nice-to-have · ~3–5 days
`M15` clinic-plane audit trail (promote if a compliance review demands it) ·
`L3` working search · `L8` settings round trip · real SMS/email channel ·
read replica for reports

**Total: ~20–26 working days.** Production gate (Phases 1–4): **~9–12 days.**

---

## 5. Code Cleanup Candidates

Per RULE #1, nothing here has been deleted. Confidence reflects certainty that
removal is safe.

### Dead files — **none found**

Every file in `apps/` is reachable. All 13 tenant-web pages are routed in
`App.tsx`; `PatientPicker`, `MedicalRecordCard`, and `ui.tsx` all have live
importers; every module in `app.module.ts` is registered. Verified by import
graph, not by inspection.

### Dead code

| Item | Confidence | Notes |
|---|---|---|
| Invoice retry loop (`finance.module.ts:220-247`) | **High** | Unreachable as intended — the retry path always fails with `25P02` (**H5**). Fix, do not delete |
| Reminder `continue`-on-`23505` (`reminders.module.ts:200`) | **High** | Same defect (**H6**) |
| `tokenStore.refresh` getter | **High** | Never read (**H3**). Delete only if refresh is abandoned — otherwise it is about to be used |
| `POST /api/auth/refresh` | **High** | Live endpoint with no caller. **Do not delete** — Phase 3 needs it |
| `'cancelled'` / `'trial'` tenant-status branches | **High** | Unreachable since migration `0004` (**H1**) |

### Duplicate components / services

| Item | Confidence | Recommendation |
|---|---|---|
| `lib/api.ts` request wrapper duplicated across both SPAs | **High** — genuinely duplicated | **Keep.** They differ correctly: tenant-web sends `X-Tenant-Subdomain` and holds a refresh token; admin-web does neither. Extracting to `packages/` costs more than it saves at this size |
| `private tx()` helper repeated in 7 services | **High** | Consolidate into a base class in Phase 7 — genuine duplication |
| Column-map + `map()` row-mapper pattern in ~6 services | **Medium** | Repetitive but readable and explicit. Low-value refactor; do not force it |
| `RLS()` helper redefined in migrations `0007` and `0009` | **High** | **Leave.** Applied migrations are immutable history — never edit them |
| `CurrentUser` / `CurrentAdmin` decorators | **High** | Deliberately parallel, different payload types. Not duplication |

### Legacy / experimental code — **none found**

No commented-out blocks, no `TODO`/`FIXME`/`HACK` markers, no `.bak`/`.old`
files, no experimental branches in the tree. The codebase is unusually clean on
this axis.

### Unused dependencies

| Package | Confidence | Notes |
|---|---|---|
| `rxjs` (api) | **Low — keep** | A required NestJS peer dependency, not directly imported |
| `class-transformer` | **High — keep** | Used via `@Type()` in `finance.module.ts` and required by `ValidationPipe({ transform: true })` |
| `zod` | **High — keep** | Environment validation |
| `pino-pretty` | **High — keep** | Dev transport, correctly a devDependency |
| `dotenv` | **High — keep** | Used by `scripts/seed.js` |
| **No unused runtime dependency identified** | **High** | Every declared package resolves to a real use |

### Unused environment variables

| Variable | Confidence | Recommendation |
|---|---|---|
| `REDIS_URL` | **High — unused** | Validated in `env.validation.ts`, referenced only in a comment about future BullMQ. Remove, or adopt (below) |
| `JWT_REFRESH_TTL` | **Medium** | Used server-side to sign refresh tokens, but no client consumes them (**H3**). Becomes live in Phase 3 — **keep** |
| `DEV_TENANT_SUBDOMAIN` | **High — keep** | Live in the dev path; scope it explicitly per **H7** |
| `POSTGRES_USER/PASSWORD/DB` | **High — keep** | Consumed by `docker-compose`, not by the app |

### Unused Docker configuration

| Item | Confidence | Recommendation |
|---|---|---|
| `redis` service in `docker-compose.yml` | **High — unused** | Nothing connects to it. Remove, or adopt |
| `api` service in `docker-compose.yml` | **High — broken, not unused** | Cannot boot (**M2**). Fix rather than remove — it is the local parity path |
| `apps/api/Dockerfile` | **High — keep** | Correct, builds clean, and is the deployment artefact for Options A/B/C |

### Unused Redis configuration

Redis is **entirely unused**: no client library, no import, no connection.
Two coherent choices:

- **Remove** (`docker-compose` service + `REDIS_URL`) — **High confidence**,
  cleanest today.
- **Adopt** — Redis would serve three items already in this plan: throttler
  storage (**H4**) across multiple replicas, refresh-token revocation
  (**M6**), and a distributed lock or queue for the scheduler (**H6**).

> **Recommendation:** defer the decision to Phase 6, after Phase 5 has settled
> the scheduler's shape. If the scheduler becomes a single-replica worker, Redis
> is unnecessary — remove it. If it stays in-process across replicas, Redis
> becomes required infrastructure. Removing it now risks re-adding it in three
> weeks.

---

## 6. Implementation Roadmap

Ordered strictly by priority. Each step is independently shippable.

| # | Work | Phase | Sev | Days |
|---|---|---|---|---|
| 1 | Guard `seed.js` against production (`C1`) | 1 | Critical | 0.25 |
| 2 | Require `APP_DATABASE_URL` in prod; assert non-superuser role at boot (`C2`) | 1 | Critical | 0.5 |
| 3 | Fix archived-tenant gate; allowlist `'active'` (`H1`) | 1 | High | 0.25 |
| 4 | Login rate limiting, both planes (`H4`) | 2 | High | 0.5 |
| 5 | Fail-closed tenant header (`H7`) | 2 | High | 0.25 |
| 6 | helmet · split JWT secrets · migration quoting · PII out of logs (`M4`,`M5`,`M10`,`M14`) | 2 | Medium | 1 |
| 7 | Password change + owner-initiated reset (`H2`) | 3 | High | 1.5 |
| 8 | Silent refresh + rotation + revocation + real logout (`H3`,`M6`) | 3 | High | 2 |
| 9 | Choose deployment target; CORS from env; fix compose (`M3`,`M2`) | 4 | High | 1 |
| 10 | Vercel rewrites, wildcard DNS + TLS, staging environment | 4 | High | 1.5 |
| 11 | Backups **with tested restore** + monitoring (`L7`) | 4 | High | 1 |
| 12 | CI: build + tests + RLS isolation tests (`M9`) | 4 | Medium | 1.5 |
| 13 | Invoice numbering via counter row (`H5`) | 5 | High | 0.75 |
| 14 | Extract scheduler to single-replica worker; fix conflict handling (`H6`) | 5 | High | 2 |
| 15 | Deliver reminders outside the transaction (`M1`) | 5 | Medium | 1 |
| 16 | Pagination on remaining list endpoints (`M11`) | 5 | Medium | 1 |
| 17 | `pg_trgm` search index · round-trip reduction (`M13`,`M12`) | 5 | Medium | 0.75 |
| 18 | Cleanup: Redis decision, workspace glob, stray dir, stale comments | 6 | Low | 1 |
| 19 | Split controllers/services out of modules; shared `tx()` base; exception filter (`M8`) | 7 | Medium | 4 |
| 20 | Clinic-plane audit trail (`M15`) | 8 | Medium | 2.5 |
| 21 | Working global search · settings round trip · real SMS channel | 8 | Low | 2.5 |

**Production gate — steps 1–12: ~11 days.**
**Full plan — steps 1–21: ~26 days.**

### Sequencing notes

- Steps **1–3 are non-negotiable and cost one day.** Do them before anything
  else, including deployment work. Either Critical alone exposes every tenant's
  medical and financial data.
- Step **12 (CI + RLS isolation tests) should ideally move earlier.** It is
  placed after deployment because it needs an environment to run against, but
  every fix from step 13 onward is safer with it in place. If schedule allows,
  pull the isolation tests forward to Phase 1 — they are the regression net for
  `C2` specifically.
- Step **14 is the gate for horizontal scaling.** Until it lands, the API must
  run at exactly one replica. Document this as an operational constraint the day
  you deploy, or `H6` will surface as intermittent reminder failures that are
  hard to diagnose.
- Step **19 is deliberately last.** The unconventional module layout is coherent
  and well-documented; refactoring it before tests exist trades real risk for
  stylistic gain.

---

## 7. Closing Assessment

The engineering instincts on display here are good ones. Isolation is enforced
where it cannot be bypassed rather than where it is convenient; money is
integers; idempotency is a unique index rather than an application check; the
comments explain intent rather than restating syntax. That foundation is why the
remediation is three weeks rather than three months.

The defects cluster in a recognisable pattern: **the gap between "works on one
machine in development" and "safe on N machines in production."** The seed script
assumes a development database. `APP_DATABASE_URL` being optional assumes a
developer who will notice a warning. `NODE_ENV` gating tenant resolution assumes
the variable is always set correctly. The scheduler assumes one process. The
retry loops assume a transaction survives an error. Each is reasonable in the
context it was written; each fails in production.

Fix the two Critical issues first — they cost one day and are each individually
sufficient to expose every clinic's medical records. Then work the phases in
order.
