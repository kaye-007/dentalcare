# DentalCare — Repository Audit

**Date:** 2026-09-26 · **Branch:** `production-hardening` @ `2fb91f5` · **Auditor:** Claude (read-only pass, no product code changed)

This is an audit of the working tree as it exists on disk, not of the last
commit. That distinction is the single most important finding here — see §17
and §18.

**How this was verified.** Everything below was read from source or produced by
running the repository's own commands on 2026-09-26. Where something could not
be verified, it says so. Nothing here was taken from the existing docs without
checking it against the code.

| Check                                                              | Result                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `npm run typecheck`                                                | ✅ pass                                                                         |
| `npm test` (unit, includes `packages/shared` and `scripts/` specs) | ✅ 43 suites, 695 tests                                                         |
| `npm run build` (shared, api, tenant-web, admin-web)               | ✅ pass                                                                         |
| `npm run lint`                                                     | ✅ pass                                                                         |
| `npm run cf:dry-run` (all three Workers)                           | ✅ pass                                                                         |
| `npm run format:check`                                             | ❌ 80 files need Prettier — CI would fail                                       |
| `npm run doctor`                                                   | ❌ database unreachable; `.env` tenant resolution incomplete                    |
| `npm run test:integration` (27 suites)                             | ⚠️ **not run** — no PostgreSQL available (Docker daemon down, no local install) |
| `npm run audit:classes`                                            | ✅ no missing classes; 13 dead CSS classes in admin-web                         |
| TODO / FIXME / HACK / XXX                                          | none in source, migrations, worker, scripts                                     |
| Unimported source files                                            | none (332 files checked)                                                        |

---

## 1. Current architecture

npm-workspaces monorepo, Node ≥ 20 (tested on 24.13).

| Workspace         | What                                                                                                                | Size (non-test TS)                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/api`        | NestJS 11 API, both planes                                                                                          | ~31,400 lines, 44 controllers                                    |
| `apps/tenant-web` | Clinic SPA, React 18 + Vite + react-router 7                                                                        | ~27,900 lines                                                    |
| `apps/admin-web`  | NODE X platform console SPA                                                                                         | ~7,600 lines                                                     |
| `packages/shared` | Permissions, money, VAT, tooth notation, reminders, messages, cash-drawer, CSV, patient import, features, API types | consumed from **source** by the API tests, from `dist` by builds |
| `infra/docker`    | compose: Postgres → one-shot `migrate` → API                                                                        |                                                                  |

API layout: `src/core/*` (cross-cutting: audit, authz, config, database,
entitlements, health, idempotency, mfa, money, oauth, pdf, request-context,
sessions, storage, tenancy) and `src/modules/{clinic,platform}/*` (one folder per
domain). No ORM — raw SQL through `pg`, schema owned by `node-pg-migrate`
migrations. Frontend state is plain React state/context; no Redux/React Query.

Two runtimes from one build, selected by `RUNTIME`:
`node` (container, resident pools, in-process `setInterval` schedulers, **single
replica only**) and `workers` (Cloudflare Worker, per-request 1-connection pool
in front of Hyperdrive, Cron Trigger every 15 min drives reminders + fiscal
retries). README states the primary production runtime is **still undecided**.

## 2. Current features

Present and wired end-to-end (API route + SPA screen), by static inspection:

- **Clinic plane:** patients (CRUD, CSV import, medical history: allergies,
  conditions, medications, notes), patient history, documents (x-ray, photo,
  consent, referral, insurance… with file-signature sniffing and signed URLs),
  appointments with status machine (scheduled → checked_in → in_progress →
  completed; cancel; no-show → rebook) and DB-level double-booking protection,
  operatories/rooms, staff availability, schedule closures, treatments/procedure
  codes, charting + odontogram (arch view), periodontal charting, clinical
  signing and withdrawal-with-reason, treatment plans + cost engine + estimates,
  invoices, payments, voids, patient ledger + adjustments, expenses, cash drawer
  (sessions, drops, payouts, float, blind count, manager approval / PIN,
  force-close, post-close voids), Albanian fiscalization (NSLF signing, CIS
  SOAP delivery, 48h retry queue, cash deposits, QR receipt), inventory with
  lots/expiry/recall, reminders (SMS via Twilio, WhatsApp, Viber via Vonage,
  delivery receipts), patient messaging, reports, analytics, finance summary,
  clinic activity trail, settings (clinic profile, VAT, fiscal, channels,
  features), staff & payroll, sessions & MFA self-service, Google sign-in.
- **Platform plane:** tenants (create wizard, suspend/reactivate, trial, delete
  - restore window, subdomain change with typed confirmation), plans +
    entitlements + per-tenant overrides, platform billing (subscription invoices,
    payments), usage/storage, cross-tenant activity, platform audit, platform
    auth with mandatory MFA in production.

## 3. Database / migration inventory

16 migrations, 57 tables. **Only `0001` is committed; `0002`–`0016` are
untracked files** (§17).

| #    | Purpose                                                                               | Lines | In git                |
| ---- | ------------------------------------------------------------------------------------- | ----- | --------------------- |
| 0001 | Baseline (squash of an earlier 0001–0021), 33 tables, grants, RLS, `resolve_tenant()` | 3086  | tracked, **modified** |
| 0002 | Inventory                                                                             | 183   | no                    |
| 0003 | Clinical roles                                                                        | 43    | no                    |
| 0004 | Clinical record integrity (DELETE revoked, sign-locks, access log)                    | 354   | no                    |
| 0005 | Sessions + MFA (opaque rotating refresh tokens, TOTP, recovery codes)                 | 207   | no                    |
| 0006 | Money in minor units, one currency per clinic, payer                                  | 239   | no                    |
| 0007 | Inventory lots, expiry, traceability                                                  | 298   | no                    |
| 0008 | Reminder delivery                                                                     | 171   | no                    |
| 0009 | Clinic operations (profile, calendar, channels, import, photos)                       | 248   | no                    |
| 0010 | Albanian fiscalization + fiscal locks on invoices/payments                            | 272   | no                    |
| 0011 | Platform lifecycle (delete + restore)                                                 | 67    | no                    |
| 0012 | Albanian market (patient messages, ID documents, EUR quotes, FX)                      | 230   | no                    |
| 0013 | Foundations (accountant role, locations, idempotency, request evidence)               | 275   | no                    |
| 0014 | Cash drawer                                                                           | 417   | no                    |
| 0015 | Which document a payment issues                                                       | 92    | no                    |
| 0016 | Platform billing                                                                      | 110   | no                    |

The uncommitted edit to `0001` removes a pg_dump-emitted
`ALTER DEFAULT PRIVILEGES … GRANT … TO app_user` (it named the developer's own
role and was fail-open). Correct change — but editing an applied migration is
only safe if **no persistent database has run the old version**. Confirm that
before committing.

Global (no `tenant_id`) tables: `tenants`, `plans`, `plan_entitlements`,
`platform_admins`, `audit_log`, `fx_rates`.

## 4. Authentication / authorization model

- **Clinic login:** email + bcrypt password, or Google OAuth. Access token =
  HS256 JWT signed with `JWT_SECRET`, 15 min TTL, carries `tenantId`, `sub`,
  `role`. Refresh token = opaque, stored SHA-256, rotated on each use, grouped
  in families; replay outside a 30 s grace revokes the family.
- **MFA:** TOTP (RFC 6238), secrets sealed AES-256-GCM under
  `MFA_ENCRYPTION_KEYS`, keyed-hash recovery codes, 5 failures → 15 min lock,
  no replay. Required for clinic admins and every platform account in
  production; a clinic may require it for all staff.
- **Platform login:** separate `PLATFORM_JWT_SECRET`, separate guard, separate
  MFA tables.
- **JwtAuthGuard** rejects typed tokens (MFA challenge tokens) and rejects any
  token whose `tenantId` ≠ the tenant resolved from the host
  (`jwt.guard.ts:46`).
- **Authorization:** permission-first. 44 permissions, 6 roles (`admin`,
  `dentist`, `hygienist`, `assistant`, `receptionist`, `accountant`) defined once
  in `packages/shared/src/permissions.ts` and used by both API and SPA.
  `@RequirePermissions()` on routes; `route-coverage.spec.ts` fails if a clinic
  route lacks a permission decision. SPA hides navigation by permission, but
  the server is the enforcement point.
- **Revocation lag:** access JWTs are not checked against the session store, so
  a revoked session / disabled user / role change takes effect within ≤ 15 min.

## 5. Tenant isolation model

Strong, and the core of the design.

1. `TenantMiddleware` runs on **every route by default**; six named exclusions
   (`health`, `platform/*`, `auth/providers`, `auth/google`,
   `auth/google/callback`, Twilio delivery webhook), each with a written reason.
2. Tenant comes from the Host subdomain via the `SECURITY DEFINER` function
   `resolve_tenant()`. `X-Tenant-Subdomain` is honoured only when
   `ALLOW_TENANT_HEADER=1` **and** `NODE_ENV≠production`.
3. Every clinic query runs through `db.withTenant()` → a transaction with
   `set_config('app.current_tenant_id', …, true)` as `app_user`
   (non-superuser, no BYPASSRLS; verified at boot, fatal in production).
4. All 51 tables with `tenant_id`, plus `tenants` itself, have RLS **enabled +
   forced** with a `tenant_isolation` policy (checked statically across all 16
   migrations). Services deliberately never filter by `tenant_id`.
5. The privileged pool is used by platform modules, and in the clinic plane
   only by the two schedulers to enumerate tenant IDs and by a dev-only check.
6. Reserved subdomains (`www admin api app mail static console status docs
support`) are refused on create and rename.

The integration suites `tenant-isolation`, `privileges`, `role`,
`api-tenant-binding`, `tenant-middleware` exist to prove this against a real
database — **not run in this audit**.

## 6. Financial model

- Integer **minor units** everywhere (`0006`); VAT in basis points; fiscal XML
  converts with integer arithmetic (`fiscal-xml.ts:82`). No floating-point
  money found.
- **Append-only:** DELETE revoked on payments and expenses; voids set
  `voided_at/by/reason` and write a reversing `ledger_entries` row; amounts are
  outside the column-level UPDATE grant. Invoice status is recomputed, not
  edited. Invoices with payments cannot be cancelled.
- **Cash drawer** is an event log (`drawer_events`) with counts, reviews,
  manager approvals (PIN), and post-close voids recorded as events.
- **Idempotency:** `Idempotency-Key` interceptor (claim → run → store response,
  24 h replay, 409 on concurrent, 422 on body mismatch) — **opt-in per route,
  header optional**. Covered end-to-end (server marks + SPA sends): record
  payment, void payment, six cash-drawer operations. **Not covered:** create
  invoice, create/void expense, ledger adjustment, generate invoice from plan,
  fiscal cash deposit (§13).
- One currency per clinic; EUR quotes via `fx_rates`.

## 7. Fiscalization model

A separate module (`modules/clinic/fiscalization`, ~3,000 lines, 24 files,
**entirely uncommitted**) that keeps the internal ledger and the CIS record
distinct:

- `fiscal_invoices`: `pending` (signed and numbered, NSLF + QR valid, awaiting
  NIVF) → `fiscalized` | `rejected`. Signed fields immutable (UPDATE grant
  only on delivery columns), no DELETE.
- `fiscal_counters`: gap-free InvOrdNum per TCR per year, row-locked.
- Signing key sealed with the MFA envelope, bound to the clinic; PKCS#12
  import including legacy 3DES/RC2 ciphers.
- Retry scheduler (5 min on Node, the 15 min cron on Workers) for the 48 h
  offline-delivery window.
- **DB triggers refuse** cancelling a fiscalized invoice or voiding a payment
  on one — so a CIS failure or refusal cannot corrupt the ledger, and the
  ledger cannot silently diverge from CIS.
- VAT: medical = exempt, cosmetic = clinic's rate (default 20%), per-procedure
  category chosen by the clinic.

**Unverified against authoritative sources:** the legal basis cited in
`vat.ts` (Ligji 92/2014 neni 51), the SOAP actions (`fiscal.service.ts:50`
says they are "to be confirmed in the test environment"), exemption codes, and
per-unit VAT rounding (`fiscal-xml.ts:245`). No evidence the module has ever
exchanged a message with the CIS **test** endpoint.

**Missing:** corrective invoices. The triggers, the UI (`InvoiceDetailPage.tsx:364`)
and the rejection message (`fiscal.service.ts:701`) all tell the user to
"issue a corrective invoice"; no code creates one. Today a mistaken payment or
invoice that has been fiscalized cannot be corrected at all.

## 8. Messaging / reminder model

- Channels behind a registry: Twilio SMS, Twilio WhatsApp (Meta-approved
  content templates per message kind), Vonage Viber. Off until configured.
- Automatic reminders: scheduler scans, a partial unique index on
  `appointment_id` makes a duplicate pass claim nothing; attempts leased with a
  delivery policy; Twilio status callbacks verified by `X-Twilio-Signature`
  against `PUBLIC_API_URL + path`.
- Patient-facing templates per locale (`ReminderLocale`); staff UI is English.
- Known (from `SECURITY_AUDIT.md`, not re-verified): an interrupted SMS attempt
  stays `sending`, nothing alerts on it.

## 9. Frontend architecture

- Both SPAs: React 18, react-router 7, plain fetch wrappers in
  `src/lib/api.ts`, context for auth, CSS files (no CSS framework), lucide
  icons. Tokens in `localStorage`; the OAuth fragment is scrubbed with
  `history.replaceState`.
- `_headers`: strict CSP (`script-src 'self'`, `frame-ancestors 'none'`,
  `object-src 'none'`), nosniff, DENY framing, COOP. No `innerHTML` anywhere.
- Navigation is permission- and feature-aware; `/` focuses a working global
  patient search.
- `tenant-web/src/lib/api.ts` is 3,422 lines and declares 132 types, many of
  which duplicate `packages/shared/src/api-types.ts`.
- **Language:** the uncommitted work deleted the Shqip dictionary, locale
  context and language toggle (`lib/i18n/*`, `LanguageToggle.tsx`). The staff
  UI is now English-only by explicit decision (`lib/strings.ts` header). Fiscal
  receipts are Albanian.

## 10. Cloudflare architecture

- `dentalcare-api` Worker: `api.dentalcare.com` custom domain, two Hyperdrive
  bindings (`HYPERDRIVE_APP` → app_user, `HYPERDRIVE_ADMIN` → owner), Cron
  `*/15 * * * *`.
- `dentalcare-tenant-web`: static assets, route `*.dentalcare.com/*`,
  `/api/*` forwarded unchanged (Host preserved) to the API over a service
  binding — same-origin, no CORS.
- `dentalcare-admin-web`: `admin.dentalcare.com`, same pattern.
- **Not deployed:** both Hyperdrive IDs are `REPLACE_WITH_…` placeholders.
  Domain `dentalcare.com` is a placeholder too (README uses
  `dentalcare.app`). `DEPLOYMENT.md` § Staging verification lists what can only
  be proven on staging; none of it is ticked.
- The wildcard tenant route also matches `api.` and `admin.`; custom domains
  take precedence, so this is benign, but it should be stated in config.
- Object storage via the S3 API (`S3_*` env), usable with R2.

## 11. Existing tests

- **Unit** (Jest, no DB): 43 suites / 695 tests, all passing — config gates,
  route permission coverage, guards, tenant middleware, MFA/TOTP/secret box,
  session tokens, OAuth state, file signatures, PDF, billing/cost/stock/lot
  engines, drawer ledger, fiscal crypto/PKCS#12/XML/queue, reminder channels +
  delivery policy, all shared modules, dev-setup and the production guard.
- **Integration** (Jest, real Postgres as both roles): 27 suites — isolation,
  privileges, role catalogue, tenant binding, sessions, MFA, throttle, trial,
  clinical record, money, checkout, cash drawer, inventory, reminders delivery,
  platform console + billing, double-booking, Albanian market, SPA parity,
  Cloudflare config. **14 of the 27 are untracked. None were run here.**
- **CI** (`.github/workflows/ci.yml`): lint, format (changed files), typecheck,
  unit, build, dry-run; migrate + integration; clean-machine compose startup
  with health up/down. Runs only on pushed code — and this work was never pushed.
- **No frontend tests** of any kind (no component, no E2E).
- README's figures (26 unit suites / 541 tests, 22 integration suites) are stale.

## 12. Existing security controls

RLS (enabled + forced, per-table grants, boot-time role check) · separate
privileged plane · host-bound tenant tokens · permission matrix with route
coverage test · rotating refresh-token families · TOTP MFA with lockout and
sealed secrets · bcrypt · global ValidationPipe (`whitelist`,
`forbidNonWhitelisted`) · helmet · 2 MB body limit · throttling (120/min
global, 10/min clinic login, 5/min platform login) · signed, expiring,
nonce-bearing OAuth state with open-redirect narrowing · Twilio signature
verification · clinical DELETE revoked + sign-locks + append-only
`patient_access_log` (fails closed) · append-only finance · fiscal triggers ·
file-signature sniffing on upload · strict CSP on both SPAs · production refuses
to boot without `APP_DATABASE_URL`, `PLATFORM_JWT_SECRET`,
`MFA_ENCRYPTION_KEYS`, `MFA_ENFORCEMENT=required` · seed/reset scripts refuse
production and non-local databases · infrastructure logs carry IDs, not names,
tokens or bodies (log statements reviewed).

## 13. Known vulnerabilities / weaknesses

Ordered by severity. None is a cross-tenant leak.

| Sev        | Finding                                                                                                                                                                                                                                                                    | Where                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **High**   | Brute-force protection is in-memory. On Workers every isolate has its own counter, so the 10/min login limit is largely ineffective; there is **no password-attempt lockout** (only MFA locks). Staff without MFA are exposed to password guessing.                        | `app.module.ts:114`, `auth.controller.ts:49`                                 |
| **Medium** | **Login CSRF on Google sign-in.** OAuth `state` is signed but not bound to the initiating browser (no cookie/nonce check), so an attacker can complete a Google login with their own account and hand the callback URL to a victim, who is then signed in as the attacker. | `core/oauth/oauth-state.ts`, `oauth.controller.ts`                           |
| **Medium** | Duplicate-submission gaps on money routes: create invoice, create/void expense, ledger adjustment, invoice-from-plan, fiscal cash deposit have no idempotency; the header is optional even where supported.                                                                | `finance/*.controller.ts`, `billing/*.controller.ts`, `fiscal.controller.ts` |
| **Medium** | Revocation lag: access JWTs are honoured for up to 15 min after logout-everywhere, disable, or role change.                                                                                                                                                                | `jwt.guard.ts`                                                               |
| Low        | Boot check that `app_user` cannot bypass RLS **fails open** if the check query itself errors, even in production.                                                                                                                                                          | `database.service.ts:113`                                                    |
| Low        | `app_user` has `INSERT` (and column UPDATE) on `tenants`. RLS makes it harmless today; it is unnecessary privilege.                                                                                                                                                        | `0001_baseline.js:3038`                                                      |
| Low        | Access + refresh tokens in `localStorage`. Mitigated by the strict CSP; `connect-src https:` is broader than needed.                                                                                                                                                       | `lib/api.ts`, `_headers`                                                     |
| Low        | Reserved-subdomain list enforced in application code only.                                                                                                                                                                                                                 | `tenants.service.ts:18`                                                      |

Least-privilege questions (decisions, not bugs): the **receptionist** holds
`clinical:read` (full clinical record), `expenses:read` (all clinic spending),
`payments:void` and `expenses:void` without manager approval.

## 14. Dead / unused code

Very little. No unimported source files; no TODOs. 13 unused CSS classes in
admin-web (`audit:classes` lists them). `@nestjs/throttler` default storage is
not dead but is ineffective on Workers (§13). The `LEGACY_ROLES` mapping
(`owner`, `frontdesk`, `reception`) is needed only while pre-`0012` sessions can
still exist — removable once all refresh tokens have rotated. Export-level dead
code was not analysed (no ts-prune in the toolchain).

## 15. Duplicate code

- `private tx()` (wrap `withTenant(getRequiredTenantId())`) copied into **18**
  services. The older m16 copy had extracted a `TenantScopedService` for it.
- SPA formatters: `fmtDate` ×7, `fmtTime` ×5, `fmtDateTime` ×4,
  `formatBytes` ×3, `money` ×2.
- `tenant-web/src/lib/api.ts` redeclares response types that live in
  `packages/shared/src/api-types.ts`.
- Business rules themselves are **not** duplicated: permissions, VAT, money,
  tooth notation, cash-drawer arithmetic and reminder wording each live once in
  `packages/shared`.

## 16. UX problems

From static reading only — **no session with a real receptionist or dentist**
was observed, and the app was not run (no database).

1. **Staff UI is English-only** for an Albanian market of non-technical users.
   This was a deliberate recent decision and deleted a (partial, 131-line)
   Shqip dictionary. Needs a product decision.
2. 17 navigation destinations for an admin; permission filtering trims them
   for other roles, but the receptionist still sees Finance items that the
   owner may consider owner-only (expenses).
3. No doctor-specific "my patients today" view. The dashboard shows the
   clinic's schedule to everyone.
4. The fiscal-correction dead end (§7) is a UX failure as much as a legal one:
   the UI tells the user to do something the product cannot do.
5. Large single-file screens (`InventoryPage` 1,367 lines, `ReservationsPage`
   1,209, `PatientProfilePage` 1,018) suggest dense pages; not assessed live.
6. No mobile shell / PWA (the m16 copy had one).

What is good: the dashboard leads with today's schedule and quick actions;
money cards are shown only to roles with `reports:read`; `/` jumps to patient
search from anywhere; appointment statuses are few and irreversible where
they should be.

## 17. Production blockers

1. **~70,000 lines of work are uncommitted and unpushed.** 170 modified files
   (+28,453 / −7,182) and 139 untracked files (~42,400 lines), dated
   2026-09-09 → 09-18. This includes **MFA, sessions, idempotency, money,
   fiscalization, cash drawer, inventory, platform billing, migrations
   0002–0016 and 14 integration suites**. It exists only on this disk and in
   `Desktop/Projekte SaaS/dentalcare.zip` (verified byte-identical for
   apps/packages/scripts/docs/infra). One disk failure loses it; CI has never
   seen it; `origin/main` is a single "Add project files" commit.
2. **Integration suite not run** on this tree during this audit. Isolation is
   designed correctly, but not proven here.
3. **Fiscalization unverified** against current Albanian requirements and the
   CIS test environment, and **no corrective-invoice flow**.
4. **Deployment target undecided;** Workers config has placeholder Hyperdrive
   IDs and domain; staging checklist not executed.
5. **Backups:** designed as provider point-in-time recovery; no restore has
   been rehearsed (DEPLOYMENT.md requires one before the first paying clinic).
6. **Credential brute-force protection** ineffective on Workers (§13).
7. **Language decision** for the Albanian market (§16.1).
8. `format:check` fails (80 files) — CI will be red on the first push.

## 18. Repository divergence analysis

The docs warn that this repository "diverges from another copy" —
`Downloads/dentalcare-m16/dentalcare`, said to have 32 migrations to this
repo's 11 and features absent here. **That warning is out of date.**

|                  | This repo (working tree)                 | m16 (`Downloads/dentalcare-m16.zip`, 2026-08-10) |
| ---------------- | ---------------------------------------- | ------------------------------------------------ |
| Folder on disk   | yes                                      | **no — only the zip remains**                    |
| Git history      | 39 commits, remote `kaye-007/dentalcare` | 13 commits, **unrelated** history, no remote     |
| Latest work      | 2026-09-18 (uncommitted)                 | 2026-07-02 (last migration)                      |
| Migrations       | 16 (baseline squash + 15)                | 32 (0001–0032)                                   |
| Tables           | 57                                       | 31                                               |
| App source files | 386                                      | 145                                              |

m16-only tables and where they went:

| m16                                                        | Here                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `tooth_records`                                            | `tooth_conditions`                                                   |
| `treatment_items`, `treatment_plan_steps`                  | `treatment_plan_items`                                               |
| `patient_images`                                           | `patient_documents` (kinds `xray`, `photo`, …)                       |
| `patient_alerts`                                           | `patient_allergies` / `_conditions` / `_medications`                 |
| `activity_log`                                             | `clinic_audit_log` + `patient_access_log`                            |
| `user_mfa_recovery_codes`, `platform_admin_recovery_codes` | MFA tables in `0005`                                                 |
| `staff`                                                    | `users` + `staff_availability` + payroll                             |
| message templates / clinic identity (m16 0032)             | per-kind templates in `shared/messages.ts`, clinic profile in `0009` |
| `backup_runs`                                              | **deliberately not carried** — backups are the provider's PITR       |
| `waitlist_entries`                                         | **absent**                                                           |
| mobile-first shell / PWA                                   | **absent**                                                           |

**Conclusion:** this working tree is a superset of m16 in every area except the
waitlist and the mobile/PWA shell. There is nothing to merge from m16. It
should be archived, not reconciled. The second copy,
`Desktop/Projekte SaaS/dentalcare.zip` (2026-09-25), is a backup of this
working tree, not a divergent line.

The **real** divergence is between this working tree and its own git history
(§17.1).

## 19. Recommended phase plan

Nine phases. Details, order, and exit criteria are in
[`CLAUDE_EXECUTION_PLAN.md`](CLAUDE_EXECUTION_PLAN.md).

| #   | Phase                                                                                                                | Complexity                       |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 0   | Secure the uncommitted work (commit in reviewed slices, push to a branch)                                            | S — but first and non-negotiable |
| 1   | Prove the tree on a real database (integration, fresh migrate, doctor, format)                                       | S–M                              |
| 2   | Close the money gaps (idempotency on remaining routes; void policy)                                                  | M                                |
| 3   | Authentication hardening (durable rate limit + lockout, OAuth login-CSRF, fail-closed boot check, drop excess grant) | M                                |
| 4   | Least-privilege decisions applied to the matrix                                                                      | S                                |
| 5   | Fiscalization: verify rules, CIS test environment, corrective invoice                                                | L                                |
| 6   | Deployment decision, staging checklist, backup/restore rehearsal                                                     | M                                |
| 7   | Daily-workflow UX pass, incl. the language decision                                                                  | M–L (L if Shqip)                 |
| 8   | Documentation truth pass + retire divergence warnings                                                                | S                                |

Deliberately **not** a phase: consolidating `tx()`, formatters and `api.ts`.
Worth doing, but only opportunistically inside a phase that already touches
those files — never as a sweep.

## 20. Files / modules affected by each phase

| Phase | Files / modules                                                                                                                                                                                                                                                                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Whole working tree; `.gitignore`; no source edits                                                                                                                                                                                                                                                                                              |
| 1     | `infra/docker/*`, `.env` (local), `apps/api/test/integration/*`; Prettier on the 80 files flagged                                                                                                                                                                                                                                              |
| 2     | `api/src/modules/clinic/finance/{invoices,expenses}.controller.ts`, `billing/{patient-ledger,plan-invoice}.controller.ts`, `fiscalization/fiscal.controller.ts`, `core/idempotency/*`, `tenant-web/src/lib/api.ts` + calling pages, `test/integration/money.itest.ts`, `checkout.itest.ts`                                                     |
| 3     | `app.module.ts` (throttler storage), `modules/clinic/auth/*`, `modules/platform/auth/*`, a new migration for login-attempt state, `core/oauth/{oauth-state,oauth.controller}.ts`, both `AuthCallbackPage.tsx`, `core/database/database.service.ts`, a migration revoking `INSERT` on `tenants`, `api-throttle.itest.ts`, `privileges.itest.ts` |
| 4     | `packages/shared/src/permissions.ts` (+ spec), possibly `finance/payments.controller.ts` for approval, `route-coverage.spec.ts`                                                                                                                                                                                                                |
| 5     | `modules/clinic/fiscalization/*`, `packages/shared/src/vat.ts`, a new migration (corrective invoice linkage), `InvoiceDetailPage.tsx`, `FiscalQueuePage.tsx`, `FiscalReceiptPage.tsx`, fiscal integration tests                                                                                                                                |
| 6     | `apps/*/wrangler.jsonc`, `apps/api/worker/*`, `docs/DEPLOYMENT.md`, `.env.production.example`                                                                                                                                                                                                                                                  |
| 7     | `tenant-web/src/lib/strings.ts` (and possibly restoring `lib/i18n/*`), `DashboardPage.tsx`, `AppLayout.tsx`, `ReservationsPage.tsx`, `PatientProfilePage.tsx`                                                                                                                                                                                  |
| 8     | `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_AUDIT.md`, `docs/RELEASE_CHECKLIST.md`, `docs/CHANGELOG.md`                                                                                                                                                                                                                                |
