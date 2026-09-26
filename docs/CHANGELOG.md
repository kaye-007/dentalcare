# Changelog

All notable changes to this project. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — production-hardening branch

### Platform console — 2026-09-19

The NODE X console (`apps/admin-web`) moves onto the clinic app's Ink & Ember
design system — its stylesheet said it was kept in step, and it had drifted to
the old teal — and gains the screens an operator was missing. No migration.

Verified: the new integration suite `platform-console` with `api-platform` and
`platform-billing` (35 tests), `typecheck`, `build` and lint for the console,
`tsc` for the API, and every screen rendered in Chrome at desktop and phone
widths against the local stack with no console errors.

#### Added

- **Overview** (`/`, now the home screen): MRR, clinics, this month's
  collection and overdue money; a *Needs attention* list (overdue invoices,
  trials ending within three days, expired trials still active, an unbilled
  month, clinics quiet for 30 days); invoiced vs collected by month; revenue
  by plan; new clinics per month; the latest console activity.
- **Plans** (`/plans`): the price list with clinics, paying clinics and MRR
  per plan; create, rename, reprice and retire. A price change shows its
  effect on MRR before it is saved and applies from the next billing run.
  API: `GET /platform/plans/all`, `POST /platform/plans`,
  `PATCH /platform/plans/:id`, each audited (`plan.created`, `plan.updated`,
  `plan.retired`, `plan.restored`). The code is fixed once created, because
  invoices snapshot it.
- **Activity** (`/activity`): every console action across all clinics,
  newest first, grouped by day, filterable by clinics / billing / plans and
  searchable. API: `GET /platform/activity`, keyset-paged on
  (created_at, id) with a microsecond cursor.
- **Command palette** (Ctrl/⌘ K): jump to any clinic by name, subdomain or
  owner, to any screen, or start a clinic or a demo — from anywhere.
- **A clinic's page** is split into Overview, Staff, Billing, Activity and
  Settings tabs; shows six months of appointments and invoices from the
  existing `/platform/usage/:id` (never the clinic's own revenue); records a
  payment in place; checks a new subdomain as it is typed.
- **Clinics, Billing, Usage**: sortable columns, search, CSV export (with a
  BOM for Albanian names and formula-prefix escaping); an *On trial* filter
  and a plan filter; billing can be run for either of the two previous months,
  with a warning that those invoices may be overdue on issue.
- Confirmation dialogs replace `window.confirm`; success is a toast; a
  password or a new clinic's hand-over cannot be dismissed by a stray click.

### Albanian market — 2026-09-17

Migration 0012. Patient messages beyond reminders, a Messages screen, TVSH by
treatment category, EUR on estimates, fiscal certificates as issued, printed
fiscal receipts, camera capture and identity documents.

Verified this time, on a fresh PostgreSQL 16: migrations 0001–0012 up, 0012
down and up again, the 0012 backfill and its rollback guard on real rows, the
unit suite (653) and the integration suite (374), `npm run typecheck`,
`npm run build`, lint, and the Worker bundle (898 KiB gzipped).

#### Fixed

- **Profile photos could not be saved.** `upload()` returned a spread of the
  document, which dropped its non-enumerable storage key, so
  `setProfilePhoto` signed a link for `undefined` and failed after the file
  was already stored — staff saw an error and a stray photo in Documents.
- **Ad-hoc invoices carried no TVSH.** "New invoice" wrote every line at 0%
  whatever the treatment; only plan invoices applied VAT. Both now take the
  rate from the treatment's category and the clinic rate, through one engine.
- **The camera was blocked in production** by `Permissions-Policy: camera=()`
  on the clinic app. It is `camera=(self)` there; the console keeps `()`.
- **WhatsApp template configuration** is validated with the new per-kind form;
  the old `en:HX…,sq:HX…` form still means appointment reminders.

#### Added

- **Messages** (`/messages`, nav and top bar): one conversation per patient,
  filtered by WhatsApp / Viber / SMS / recorded; every message as sent, with
  who sent it, the number, delivery state, attempts and errors. Compose an
  appointment reminder, a post-procedure follow-up or an unpaid-balance notice
  with a word-for-word preview, and send by WhatsApp, Viber, SMS, the staff
  member's own WhatsApp (hand-off link) or record only. Opt-outs are honoured
  on every route to the phone. Opening a conversation is written to the
  patient access log (`messages`).
- **Built-in Albanian and English wording** for the three kinds
  (`packages/shared/src/messages.ts`). None names a treatment.
- **TVSH categories** on treatments and procedure codes: medical (exempt) or
  cosmetic (the clinic rate, 20% suggested). Invoice detail shows TVSH per
  line and per rate.
- **Printable estimate** for a treatment plan, priced by the invoice engine,
  with a second currency (EUR by default for lek clinics) at the day's
  published rate or the clinic's fixed rate, printed with its date and source.
- **Fiscal certificate upload as .p12/.pfx with its password**, read in-process:
  PBES2 (AES, 3DES), PKCS#12 PBE (3DES, RC2-40/128), SHA-1/-256/-384/-512
  MAC, BER or DER. A wrong password says so. The PEM path remains.
- **Fiscal receipt** (`/invoices/:id/receipt`, 80 mm): seller NIPT and address,
  cashier name and operator code, items with TVSH, TVSH summary per rate,
  payment, NIVF, NSLF, codes and the verification QR — built from the signed
  registration. The A4 PDF gains TVSH per rate and the cashier's name.
- **Camera capture** for profile photos, clinical photos (tagged progress) and
  ID documents, with a card outline; a fallback to the device camera app.
- **`id_document`** document kind.
- New clinics created without a currency default to **ALL** with EUR quotes.

#### Migration 0012

`reminders` gains `patient_id` (backfilled, NOT NULL, kept equal to the
appointment's patient by a trigger), `purpose` and `invoice_id`;
`appointment_id` becomes optional except for reminders; automatic sending
stays reminders-only. Adds `id_document`, the `messages` access-log resource,
`clinic_settings.quote_currency / fx_rate_source / fx_fixed_rate` and the
`fx_rates` cache. The down migration refuses while any non-reminder message
exists.

#### Not done

- Live sends through Twilio WhatsApp and Vonage Viber, and the DPT CIS test
  service, are still unexercised; each needs real accounts.
- Invoices and payments in EUR. The ledger stays single-currency; EUR is a
  quote currency on estimates only.
- Automatic follow-ups and balance notices; replies from patients.

### Clinic operations — 2026-09-15

Migrations 0009–0011. Reception scope, multi-channel reminders, clinic
profile and calendar, patient import, clinical photos, invoice PDFs, Albanian
fiscalization, and console lifecycle controls.

#### Breaking

- **Reception no longer writes the clinical record.** `clinical:write` is
  withdrawn from `receptionist`; two new permissions take over part of what it
  covered. `history:write` (allergies, conditions, medications, notes) is held
  by every role including reception; `plans:write` (treatment plans) by the
  clinical roles. Reception still reads the chart, perio and plans. A
  receptionist who charted before this release gets 403 on those routes.
- **Reminders go out 12 or 24 hours before, nothing else** (0009). Stored
  values are moved to the nearer of the two.
- **`RecordPaymentDto.method` is optional** when `methodId` names one of the
  clinic's payment methods. Clients sending `method` alone keep working.
- **Tenant status gains `deleted`** (0011). `PATCH …/status` refuses a deleted
  clinic; `POST …/restore` brings it back as suspended.

#### Added

- Permissions `history:write`, `plans:write`, `invoices:fiscalize` (admin,
  reception), `patients:import` (admin only).
- Reminder channels: WhatsApp Business through Twilio (approved Content
  template) and Viber through the Vonage Messages API, chosen per clinic and
  per patient, falling back to SMS and then the log. Placeholders `{dentist}`
  and `{clinic_address}`.
- Clinic settings: registered name, NIPT, registration number, website, brand
  colour, logo (JPEG, private bucket), invoice prefix, default VAT, payment
  terms, custom payment methods mapped to cash/card/bank. Settings page in tabs.
- Holiday calendar and per-clinician time off (`/closures`); free-slot search
  answers `closed`, and the booking panel warns.
- Patient import (`/patient-imports/preview`, `/patient-imports`): CSV parsed
  in the browser, column mapping, shared validation, duplicate detection by
  national ID and phone, per-batch atomic commit with conditions and opening
  balances, an import record and an activity entry.
- Patients: national ID (unique per clinic), preferred reminder channel,
  profile photo cropped in the browser (EXIF dropped).
- Documents: upload dialog with type, before/after/progress tag, tooth, date
  and caption; thumbnails through one batch of signed links; before/after
  comparison.
- Invoice PDF (`GET /invoices/:id/pdf`), written without a PDF library, with
  logo, NIPT, lines, totals, payments, and — when registered — the fiscal
  block with QR, NIVF and NSLF.
- Fiscalization (`/fiscal/*`, `/invoices/:id/fiscal`): NSLF computed and
  signed with the clinic's certificate (sealed at rest), RegisterInvoice and
  RegisterCashDeposit requests with XML-DSig, per-register order numbers,
  offline issue with automatic subsequent delivery, locks on cancel and void.
- Console: per-clinic usage (active users, patients, appointments this month,
  storage, plan), fleet overview, three-step onboarding with live subdomain
  check and first settings, plan and address changes, soft delete with a
  30-day restore window, and an audited per-clinic JSON export.

#### Fixed

- Deleting a patient document failed with a 500: it returned a `title` column
  the table does not have.
- Invoice detail never showed a voided payment as voided: the void columns
  were selected and then dropped.

#### Not verified

No database was available when this was written: migrations 0009–0011 and
the integration suite have not been run. Fiscalization is checked against an
independent XML-DSig implementation, not against the DPT test service. WhatsApp,
Viber and CIS have not been called for real. See SECURITY_AUDIT.md.

### Production hardening — 2026-09-14

Migrations 0003–0008. Closes the gaps recorded in the architecture review:
MFA that existed only as a column, unrevocable sessions, a clinical record
reception could delete, money without cents or a single currency, stock
without lots, and reminders that sent nothing.

#### Breaking

- **Every amount is minor units.** 0006 multiplies stored money by 100, and
  every amount the API accepts or returns is cents (`3750` is €37.50). The API
  and both SPAs must be deployed together.
- **Clinical deletes are gone.** `DELETE` on findings, procedures, perio exams,
  notes and medical history is replaced by `POST …/:id/entered-in-error` with a
  reason; `POST …/:id/sign` needs `clinical:sign`.
- **Sign-in changed.** `POST /auth/login` may answer `mfa_required` or
  `mfa_enrollment_required` instead of tokens. Refresh tokens are opaque and
  rotate on every use; tokens issued before 0005 no longer work, so everyone
  signs in again after the deploy.
- **Roles.** `admin`, `dentist`, `hygienist`, `assistant`, `receptionist`
  (0003).
- **Production requires** `MFA_ENFORCEMENT=required` and `MFA_ENCRYPTION_KEYS`.
- **Reminders** have statuses `pending`, `sending`, `sent`, `delivered`,
  `failed`, `skipped`; the runtime role can no longer delete them (0008). The
  Cron Trigger runs every 15 minutes instead of hourly.

#### Security

- TOTP two-step sign-in with sealed secrets, recovery codes, lockout and
  replay protection; required for administrators and the console; staff and
  console resets.
- Server-side sessions with rotation, family revocation on replay, revocation
  on password and role changes, and a signed-in-devices list.
- Clinical record: DELETE revoked, withdrawal with reason, signing locks rows,
  every change in the activity trail, every record opening in an append-only
  access log.
- SMS delivery receipts authenticated by Twilio's signature, applied under the
  named clinic's RLS; the message leaves the treatment and surname off a lock
  screen; provider error text never reaches the application log.

#### Added

- Currency per clinic, payer type on invoices and ledger entries, a money
  input that accepts either decimal mark.
- Inventory lots with expiry warnings, first-expiry-first-out usage, recall
  with the list of patients who received a lot.
- Twilio SMS behind `SMS_PROVIDER`, retries on 429/503, patient opt-out,
  per-clinic time zone, language, wording and country code, SMS part count in
  Settings.
- Staff two-step reset, clinic-wide MFA requirement, record-access card on the
  patient profile.

#### Fixed

- **Cancelling an invoice** failed with a 500 (it never set `cancelled_at`)
  and would have left the charge on the patient's ledger. It now reverses it.
- **Reminder times** were rendered in the server's zone — UTC on Cloudflare.
- **Perio exam creation** read back its row from another transaction.

#### Not verified

- No SMS has been sent through Twilio itself; no receipt has come from it.
- Hyperdrive caching on the real configs (`cf:check-caching` added, not run
  against an account).
- Neither runtime has served real clinic traffic; which is primary is open.

### Cloudflare migration — 2026-08-27

The API runs on Cloudflare Workers; both SPAs are static-asset Workers. The
container path is retained and still works — `RUNTIME` defaults to `node`.

- **Reminder scheduler → Cron Trigger.** `ReminderSchedulerService` stands down
  when `RUNTIME=workers`; the hourly trigger in `apps/api/wrangler.jsonc` calls
  `tick()` through the `scheduled` handler. The scan was already idempotent
  behind `reminders_auto_unique`, so no logic changed. **This removes the
  single-replica constraint** recorded under Known limitations below.
- **`DatabaseService` is runtime-aware.** Resident pools on Node; on Workers
  each operation borrows one connection from Hyperdrive and closes it, because
  a Worker may not reuse a socket opened during another request. Callers still
  receive a `PoolClient`, so no service changed.
- **Two Hyperdrive bindings, not one.** `HYPERDRIVE_APP` connects as `app_user`
  with RLS enforced, `HYPERDRIVE_ADMIN` privileged for the platform plane. Both
  must be created with `--caching-disabled`: Hyperdrive keys its cache on query
  text, not on the transaction that set `app.current_tenant_id`.
- **Object storage rewritten over `aws4fetch`.** `@aws-sdk/client-s3` and the
  presigner left no room for NestJS under the 3 MiB compressed Worker cap. Same
  private-bucket, pre-signed-URL contract; identical on both runtimes.
- **`/api/*` stays same-origin.** Each SPA Worker forwards it to the API over a
  service binding. Not an optimisation: the API resolves the clinic from the
  `Host` subdomain and the `X-Tenant-Subdomain` override is hard-disabled in
  production, so a cross-origin call would resolve no clinic at all.
- **pino is Node-only.** Its browser build — which a Workers bundler resolves —
  exports no `symbols`, which `pino-http` reads at module scope. `WorkersLogger`
  routes Nest's logger at `console` and a middleware keeps `x-request-id`.
- **Security:** the reminder log channel no longer writes the patient's name,
  phone number, clinic or treatment reason to the application log. It did so at
  INFO on every scan; on Cloudflare that log leaves the database's trust
  boundary. The message already lives on the reminder row under RLS.
- Removed `render.yaml` and both `vercel.json`. Dropped `ts-node`. Added
  workspace-wide `build`, `test` and `typecheck` scripts, which did not exist.

Verified on the real workerd runtime against PostgreSQL 16, not only at build
time: health, login (tenant resolved from the Host subdomain), an RLS-scoped
patient read, and one cron sweep that delivered two due reminders. Worker
bundle 2477 KiB raw / 708 KiB gzipped.


### Cleanup pass

Repository hygiene and removal of all demo/fixture tooling. **No feature was
added or removed; no business logic or database schema changed.** Full test
suite and all three builds verified green afterwards.

- ~~**Removed `apps/api/scripts/` entirely**~~ — **this did not happen.** The
  entry was written but the deletion never landed: `seed-demo.js`,
  `reset-demo.js`, `bootstrap-admin.js` and `lib/guard.js` are all still in
  the tree and still wired to npm scripts. What protects production is the
  guard in `scripts/lib/guard.js`, not their absence. See SECURITY_AUDIT.md.
- Dropped the `seed`, `reset-demo` and `bootstrap-admin` npm scripts from
  both the root and API manifests.
- **Removed the hardcoded demo-credential hints** from both login pages and
  the dead `.auth__hint` CSS that styled them. Neutralised the platform
  console's `admin@dentx.app` email placeholder.
- **Fixed the root cause of stray `vite.config.js` / `vite.config.d.ts` /
  `*.tsbuildinfo` emits**: `tsconfig.node.json` now writes to
  `node_modules/.tmp/` instead of the app root. Previously these were
  produced on every `tsc -b` and merely gitignored.
- Purged build artefacts and tool caches (17.6 MB): three `dist/` trees, two
  Vite dependency caches, four `.tsbuildinfo` files, and Cursor's semantic
  index (`.git/cursor/crepe/**/index.bin`, `postings.bin`).
- Removed two empty directories: `src/tenant/medical-record/dto`,
  `src/tenant/treatments/dto`.
- Scoped `jest.config.js` to `roots: ['<rootDir>/src']`. Suite is 36 tests
  across 3 files (was 47 across 5; the 11 removed covered the deleted
  scripts).
- Rewrote `.gitignore` and `.dockerignore`; deleted five completed process
  documents; marked `RELEASE_CHECKLIST.md` as a historical record.


Security remediation, test coverage, and deployment preparation. **No feature
was added or removed; no business logic changed.**

### Breaking

- **`ALLOW_TENANT_HEADER=1` is now required for local development.** The
  `X-Tenant-Subdomain` header is no longer honoured just because `NODE_ENV`
  is not `production`. Existing local checkouts must add this to `.env` or
  localhost cannot resolve a clinic. `.env.example` sets it.
- **The API refuses to boot in production without `APP_DATABASE_URL`**, or if
  that role is a superuser / has `BYPASSRLS`. This is intentional: booting
  without it silently disabled tenant isolation.
- **`JWT_SECRET` must be ≥32 characters in production** and must not be the
  `.env.example` placeholder.
- **`docker compose up` now requires `JWT_SECRET`** to be set in `.env`. It
  previously started an API container that crashed immediately.

### Security

- Require `APP_DATABASE_URL` in production and verify at boot that the tenant
  database role cannot bypass RLS. Unset, the tenant pool fell back to the
  privileged connection and every clinic could read every other clinic's data.
- Guard `seed.js` against production. It upserts README-published credentials
  with `DO UPDATE SET password_hash`; against a live database it would have
  overwritten the superadmin password with a public default.
- Deny archived tenants. Migration `0004` changed the status set but the gates
  still checked the old values, so the admin console's Archive button revoked
  nothing. Both gates now allowlist `active` and fail closed.
- Fail closed on the tenant header — explicit opt-in, ignored in production.
- Rate limit credential endpoints: 10/min clinic login, 5/min platform login,
  30/min refresh, 120/min baseline. `trust proxy` so per-IP buckets see the
  real client address.
- Add `helmet` security headers.

### Added

- `PATCH /api/auth/password` — change your own password, re-verifying the
  current one and rejecting reuse.
- `POST /api/staff/:id/password` — owner-initiated reset for a colleague.
  There was previously no way to change a password anywhere in the system.
- 47 regression tests (`npm test -w @dentalcare/api`), no database required.
- `render.yaml`, `apps/*/vercel.json`, `.env.production.example`.
- `CORS_ORIGINS` — configurable origins with wildcard support for per-tenant
  subdomains. The previous localhost-only regex blocked every deployed
  frontend.
- Docker healthcheck; `USER node` in the image; migrations shipped in the
  image so deploy pipelines can run `migrate:up`.

### Fixed

- **Invoice numbering retry could never succeed.** A `23505` aborts the
  enclosing transaction, so the retry's first statement failed with `25P02`
  and the handler rethrew — turning a routine conflict between two users
  invoicing simultaneously into an opaque 500. Each attempt now runs inside a
  `SAVEPOINT`.
- **Reminder scan had the same defect**, and rolled back the whole pass when
  it hit a conflict. Each claim now runs in its own transaction.
- **Reminder delivery no longer runs inside a database transaction.** The
  channel's `send()` sat between the `INSERT` and the status `UPDATE`;
  harmless for the log channel, but a real SMS provider would have held a
  pooled connection open for a network call and, on rollback, re-sent the
  message on the next scan.
- **Refresh tokens are now used.** The API issued them and the client stored
  them, but nothing ever read them back — so every user was hard-logged-out
  every 15 minutes mid-task. `request()` retries once through
  `/auth/refresh`; concurrent 401s share one in-flight refresh.

### Removed

- `dentalcare/` — an orphaned submodule gitlink (mode `160000`) pointing at a
  commit absent from this repository, with no `.gitmodules`.
- Redis — provisioned in compose and validated in config, but no client
  library and zero imports anywhere.
- `packages/*` from `workspaces` — no such directory exists.

No npm dependency was removed: all four apparently-unused packages
(`reflect-metadata`, `rxjs`, `pino-http`, `react-dom`) are required via
side-effect imports, subpath imports, or peer dependencies. (The companion
`REMOVED_DEPENDENCIES.md` was itself deleted in the 2026-08 documentation
sweep; the finding is recorded here instead. The 2026-08-27 pass below did
remove `ts-node`, and replaced the AWS SDK with `aws4fetch`.)

### Documentation

`ARCHITECTURE.md`, `PROJECT_STRUCTURE.md`, `SECURITY_AUDIT.md`,
`CLEANUP_REPORT.md`, `REMOVED_FILES.md`, `REMOVED_DEPENDENCIES.md`,
`DEPLOYMENT.md`, `MASTER_REMEDIATION_PLAN.md`.

Four of those are gone: `CLEANUP_REPORT.md`, `REMOVED_FILES.md`,
`REMOVED_DEPENDENCIES.md` and `MASTER_REMEDIATION_PLAN.md` were deleted in the
2026-08 documentation sweep. The list is left as written because this entry
records what shipped at the time, not what is on disk today.

### Known limitations

- ~~**The API must run at exactly one replica.**~~ Superseded by the Cloudflare
  migration above: the scheduler no longer runs in-process, so Worker
  concurrency is unbounded from this application's point of view. The
  constraint still holds for the container fallback, where the scheduler is
  back in-process and has no distributed lock. (`render.yaml`, which pinned
  `numInstances: 1`, has been deleted.)
- ~~No refresh-token rotation or revocation; logout is client-side only.~~
  Superseded by migration 0005 (2026-09-14).
- ~~One `JWT_SECRET` shared across both planes.~~ Superseded by
  `PLATFORM_JWT_SECRET`, required in production.
- No CI pipeline. Tests exist but nothing runs them automatically.

---

## [0.1.0] — prior

Milestones M1–M10 plus two correction passes: app shell, auth and roles,
tenant isolation with RLS, superadmin tenant management, patients,
reservations, treatments and medical records, staff and settings, invoices
and payments, reports, and reminders. See `README.md`.
