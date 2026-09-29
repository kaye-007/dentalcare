# Security Audit

Audit of the DentalCare API and SPAs, with the remediation applied on the
`production-hardening` branch. Findings were carried forward from a
remediation plan that has since been deleted from the repository; this document
records what was fixed, how it was verified, and what remains.

**Scope:** this repository snapshot, which diverges from another copy of the
project. The cleanup report that described the divergence was deleted in the
2026-08 documentation sweep.

---

## Fixed

### Security program — 2026-09-28 (migrations 0023–0025)

Evidence, commits and what remains: [SECURITY_PROGRAM.md](./SECURITY_PROGRAM.md).

- **Failed sign-ins are locked out, durably.** They are counted in the
  database (0025), so the limit holds across every Worker isolate:
  - 10 failures per account in 15 minutes locks it for 15, whether or not the
    account exists;
  - 100 failures per address locks that address;
  - keys are HMACs, so the table holds no email or IP;
  - an unknown address costs the same bcrypt work, so timing reveals no
    account.
- **Login CSRF on Google sign-in closed.** The callback requires the nonce
  cookie set by the browser that started the sign-in.
- **The RLS boot check fails closed** in production.
- **`app_user` lost INSERT on `tenants`** (0025).
- **Money routes refuse a repeated request.** `@Idempotent` covers seven
  routes, and invoices, expenses and adjustments store the key under a unique
  index (0024).
- **"Today" is the clinic's date** (0023). Invoice dates no longer disagree
  with fiscal dates after midnight.
- **Production must choose where documents are stored.** A container disk is
  no longer picked silently.
- **Backup and restore tooling, with a rehearsed restore.** The restore
  refuses non-empty targets and checks schema, rows and row security.
- **Secret scanning in CI; HSTS on both SPAs; the integration suite refuses
  the development database.**

The owner's decisions of the same day, applied on top:

- **No money moves without an Idempotency-Key.** Every route that moves
  money requires one: 428 without it, 400 for a malformed one. That is 22
  clinic routes and the console's three billing routes (0026). A unit spec
  fails the build when a money route is left unmarked.
- **A manager's PIN is no longer inside a stored request hash.** Payouts and
  floats carried it into `idempotency_keys` under SHA-256. PINs and passwords
  are now left out of the hash.
- **Reception no longer voids payments or expenses, or reads the expense
  list.** Voids are the administrator's alone. Reception keeps taking
  payments and reading the chart.

### Production-hardening pass — 2026-09-14 (migrations 0003–0008)

Each item closes a gap found by reading the code, and each is covered by the
suites listed under [Test coverage](#test-coverage).

- **HIGH — MFA existed only as a column.** `totp_secret` was in the schema and
  nothing used it. Now: TOTP (RFC 6238, tested against the RFC vectors),
  secrets sealed with AES-256-GCM under `MFA_ENCRYPTION_KEYS` bound to their
  owner, one-time recovery codes stored as keyed hashes, five failures lock a
  factor for 15 minutes, a code cannot be replayed. Required for clinic
  administrators and every console account in production; a clinic can extend
  it to all staff. The plaintext columns are dropped (0005).
- **HIGH — sessions could not be revoked.** Refresh tokens were stateless JWTs.
  Now opaque tokens stored as SHA-256, rotated on every use, grouped in
  families; replaying a spent token outside a 30-second two-tab grace revokes
  the family. Password changes, role changes and disabling an account revoke
  sessions; users can see and end their own.
- **HIGH — reception could hard-delete the clinical record, unaudited.** DELETE
  is revoked on every clinical table (0004). A wrong entry is withdrawn as
  entered in error with a reason; signed procedures and perio exams are locked
  by trigger; a procedure on a live invoice cannot be withdrawn. Every change
  is in the clinic activity trail, and every opening of a patient's record is
  in an append-only `patient_access_log` that fails closed.
- **MEDIUM — roles fitted a two-person clinic.** Five roles, a permission-first
  matrix, and signing restricted to clinicians. `route-coverage.spec.ts` fails
  the build on any clinic route without a declared, enforced permission.
- **MEDIUM — money could be summed across currencies.** Whole units per row in
  any of five currencies. Now integer cents in one currency per clinic,
  enforced by triggers (0006). Cancelling an invoice failed with a 500 and, had
  it worked, left the charge on the patient's ledger; both fixed.
- **MEDIUM — a recall could not be answered.** Stock had no lots. Lots, expiry
  and recall with patient traceability (0007); the database keeps an item's
  quantity equal to its lots and refuses use of a recalled lot.
- **MEDIUM — reminders.** The only channel logged; the message used the
  server's clock (UTC on Cloudflare) and carried the treatment. Now SMS through
  Twilio behind configuration, a lock-screen-safe message in the clinic's time
  zone, at-most-once sending, retries only when the provider says busy,
  opt-out, and delivery receipts authenticated by Twilio's signature and
  applied under the named clinic's RLS (0008). The one new route that runs
  without a clinic is pinned in `tenant-middleware.itest.ts`.

### CRITICAL — Config could silently disable all tenant isolation

`env.validation.ts`, `database.service.ts`

`APP_DATABASE_URL` was optional. Unset, the tenant pool fell back to the
privileged `DATABASE_URL` — a superuser, which bypasses RLS **including
`FORCE`**. Tenant services deliberately never filter by `tenant_id` and rely
entirely on RLS, so every query would have returned every tenant's rows. The
app logged a warning and booted normally.

**Fix.** Two independent gates:

1. Production requires `APP_DATABASE_URL` (Zod `superRefine`) — boot refused.
2. At boot, `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname =
current_user`. If the tenant role is privileged, production boot is
   refused. A _correct_ URL pointing at a _privileged_ role defeats RLS just
   as completely, so validating the string alone was not enough.

**Verified.** 10 tests in `env.validation.spec.ts`; runtime boot confirmed the
role check runs and stays silent for `app_user`.

### CRITICAL — Seed script could reset production credentials

`scripts/seed.js`

`seed.js` upserts credentials published in the README (`admin@nodex.al` /
`Admin123!`) using `ON CONFLICT … DO UPDATE SET password_hash`. Run once
against production it would overwrite the live superadmin password with a
public default — granting cross-tenant access to anyone who has read the
repo — and report "Seed complete."

**Fix.** Originally mitigated by a production guard: refused to run when
`NODE_ENV=production`, when the host or database name contains `prod`, or
against any non-local host without `ALLOW_REMOTE_SEED=yes`.

**Closed by control, not by removal.** An earlier revision of this document
claimed `apps/api/scripts/` had been deleted entirely. It had not been, and
saying so was worse than saying nothing: a reader would conclude the seed
tooling could not run against production because it no longer existed.

What is actually true: `seed-demo.js`, `reset-demo.js`, `migrate-reset.js`,
`bootstrap-admin.js` and `lib/guard.js` are all present. Every script that
writes credentials or destroys data calls `assertNotProduction()` from
`scripts/lib/guard.js` first, which refuses when

- `NODE_ENV=production`, or
- the host or database name matches `/prod/i`, or
- the host is not loopback and the override variable is unset.

`bootstrap-admin.js` is the deliberate exception and is allowed to run against
production. It writes only the one account passed to it, demands a password of
at least 12 characters, and refuses to overwrite an existing account without
`FORCE_RESET=yes`. It is how the first superadmin is created on a live
deployment — see
[DEPLOYMENT.md § First platform administrator](DEPLOYMENT.md#first-platform-administrator).

**Verified.** 11 tests in `scripts/lib/guard.spec.ts` covering every refusal
path and the override. (The earlier claim of "9 tests in `seed.spec.ts`" named
a file that does not exist.)

### HIGH — Archived tenants retained full access

`tenant.middleware.ts`, `auth.service.ts`

Migration `0004` replaced the status set `('trial','active','suspended',
'cancelled')` with `('active','suspended','archived')`. Both gates still
tested the old pair, so `'cancelled'` became unreachable and `'archived'` was
never checked. The admin console's **Archive** button revoked nothing.

**Fix.** Allowlist `'active'` instead of denylisting known-bad values, in both
places, so any future status fails closed. `AuthUserRow.tenant_status` aligned
with the real constraint.

**Verified.** Parameterised test asserts denial for `archived`, `suspended`,
`cancelled`, `trial`, and an unknown status.

### HIGH — Tenant header failed open

`tenant.middleware.ts`

`X-Tenant-Subdomain` let the caller choose its clinic, enabled by the
_absence_ of `NODE_ENV=production`. A deploy missing one variable quietly
accepted client-chosen tenants. Token-to-tenant binding still blocked
cross-tenant reads, so impact was tenant enumeration and credential probing
against arbitrary clinics rather than a data leak.

**Fix.** Requires explicit `ALLOW_TENANT_HEADER=1` **and** is ignored outright
in production.

**Verified.** Tests assert the header is ignored without the flag, ignored in
production even with the flag, and that `Host` wins.

### HIGH — No password management existed

API-wide

No password could be changed by anyone, anywhere. Staff were created with an
owner-chosen temporary password that could never be rotated, and a forgotten
owner password required direct database access. Compromised credentials had no
remediation path short of disabling the account.

**Fix.** `PATCH /api/auth/password` (re-verifies the current password, rejects
reuse) and owner-only `POST /api/staff/:id/password`. The reset is a separate
endpoint from the general staff `PATCH` so a password can never be set as a
side effect of an unrelated update.

### HIGH — No rate limiting on credential endpoints

Both logins were unthrottled. The platform login gates cross-tenant access.

**Fix.** `@nestjs/throttler` globally (120/min), 10/min on clinic login, 5/min
on platform login, 30/min on refresh. `trust proxy 1` so per-IP buckets see
the real client address behind a reverse proxy rather than bucketing everyone
together.

**Verified.** 130 requests to `/api/health` → 118×200 then 429s.

### MEDIUM — No security headers; CORS blocked all production origins

**Fix.** `helmet` (HSTS, nosniff, frame options, referrer policy). CORS
origins now come from `CORS_ORIGINS` with wildcard support for per-tenant
subdomains; the previous `localhost`-only regex would have blocked every
deployed frontend.

**Verified.** Headers confirmed on a live response.

---

## Verified correct — not defects

Checked explicitly so they are not "fixed" into breakage later.

- **RLS coverage is complete.** Every table with a `tenant_id` carries
  `ENABLE` + `FORCE ROW LEVEL SECURITY` and an identical `tenant_isolation`
  policy. `role.itest.ts` reads that list from the catalogue, so a new table
  without a policy fails the suite rather than relying on this sentence.
- **Cross-plane token confusion is blocked both ways.** A platform token has
  no `tenantId` (rejected by `JwtAuthGuard`); a clinic token has no
  `scope: 'platform'` (rejected by `PlatformJwtGuard`). Both directions now
  have tests.
- **`tenants` policy omits `WITH CHECK` — this is safe.** PostgreSQL reuses
  the `USING` expression for new rows when `WITH CHECK` is absent.
- **Platform tables are protected.** Migration `0004` explicitly `REVOKE`s
  `app_user` from `platform_admins` and `audit_log`.
- **Authorization is server-enforced, not UI-only.** Every clinic route
  declares a permission and carries `PermissionsGuard`; `route-coverage.spec.ts`
  checks both. The SPA's `can()` reads the same matrix from
  `@dentalcare/shared`, so the UI hides what the API would refuse.
- **"Owner-only pricing"** means editing. Frontdesk reading the catalog is
  intended and consistent across guard, service, and UI.

---

## Outstanding

Closed since the previous revision of this table:

- refresh-token rotation and revocation;
- the shared JWT secret (`PLATFORM_JWT_SECRET`);
- the missing clinic-plane audit trail;
- patient data in the reminder log;
- migrations 0009–0011 never run. On 2026-09-28, 0001–0025 ran from zero on a
  fresh database with the whole integration suite, 556 tests.

Also closed on 2026-09-28:

- the in-memory-only login throttle;
- login CSRF;
- the fail-open RLS boot check;
- duplicate money writes;
- `app_user` INSERT on `tenants`;
- the optional Idempotency-Key, now required;
- reception's voids.

See above.

| Severity | Issue                                                                        | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | An access token outlives revocation by up to `JWT_ACCESS_TTL` (15 min)       | **Accepted residual risk for this release** (the owner, 2026-09-28; not redesigned). After a sign-out, password change, disabled account or role change, a token already issued keeps working until it expires, with the role it was issued with. Still holds: the refresh token is revoked at once; `PermissionsGuard` authorizes every request on the server; a token works only at its own clinic; row security applies; suspending a clinic takes effect on the next request. Lever: a shorter TTL. |
| Medium   | Tokens in `localStorage`                                                     | XSS-reachable. Acceptable with a strong CSP on the SPA host; otherwise an httpOnly refresh cookie.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Medium   | Platform plane uses the migration owner role                                 | Should be a dedicated least-privilege role.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Medium   | SMS never sent through the real provider                                     | Built to Twilio's documented API; tested against a local stand-in and Twilio's published signature example. See DEPLOYMENT.md staging checklist.                                                                                                                                                                                                                                                                                                                                                        |
| Medium   | Hyperdrive caching is not assertable from the repository                     | `npm run cf:check-caching -w @dentalcare/api` asks the account; not yet run against a real one.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Low      | An interrupted SMS attempt stays `sending`                                   | Deliberately not retried; nothing alerts on it yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Low      | Patient documents keep a soft delete                                         | Admin-only and audited, but not the entered-in-error model of the clinical record.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Low      | Uploads pass through the API                                                 | No pre-signed direct-to-bucket upload, which large imaging studies will need.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Low      | The baseline migration interpolates `APP_DB_PASSWORD` into SQL               | A password containing a quote breaks or alters `CREATE ROLE`. Documented in `.env.production.example`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| High     | Fiscalization not exercised against DPT's test CIS                           | Signatures verify with xml-crypto; the element set, SOAPAction values and endpoint paths are to the published schema as understood. Needs a test certificate and registered codes. Corrective invoices are not implemented, so a registered invoice cannot yet be corrected in-app.                                                                                                                                                                                                                     |
| Medium   | Fiscal signing keys share MFA_ENCRYPTION_KEYS                                | Sealed with AES-256-GCM bound to the clinic. A key rotation must re-seal certificates as well as MFA factors.                                                                                                                                                                                                                                                                                                                                                                                           |
| Medium   | Viber delivery is unconfirmed                                                | Vonage reports status to an application-level JWT-signed webhook that is not built; a Viber reminder reads "sent", never "delivered", and a non-Viber number fails silently.                                                                                                                                                                                                                                                                                                                            |
| Medium   | Platform stats and export rely on the privileged role reading across tenants | As the tenants list and reminder scheduler already did. If the platform role is ever made least-privilege and subject to FORCE RLS, these queries return zeros.                                                                                                                                                                                                                                                                                                                                         |
| Low      | Clinic export is capped at 200,000 rows and built in memory                  | Larger clinics must be exported from a database backup.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Low      | Opening balances from an import are ledger adjustments                       | Correct, append-only, and labelled with the file name; a wrong import is corrected by opposing adjustments, one patient at a time.                                                                                                                                                                                                                                                                                                                                                                      |
| Medium   | A fiscal cash declaration can be sent twice across a crash                   | The tax authority is called before the row is written. The Idempotency-Key covers double clicks and retries, but a process dying between the call and the write leaves the next attempt free to declare again. Write a pending row first, with the CIS work.                                                                                                                                                                                                                                            |
| Low      | The per-address sign-in counter trusts CF-Connecting-IP                      | Correct behind Cloudflare, which sets it. On a deployment not behind Cloudflare a client can set the header itself; the per-account lockout does not depend on it.                                                                                                                                                                                                                                                                                                                                      |
| Low      | The replay store keeps response bodies for up to 24 hours                    | Under the clinic's row security, and swept on a random 2% of requests rather than by a job, so "24 hours" is a likelihood, not a guarantee. A purge job is on the privacy checklist.                                                                                                                                                                                                                                                                                                                    |
| Info     | Reception holds `expenses:write` with no screen to use it                    | The owner's decision removed `expenses:read` and left `write`. The app hides the form, which needs the Expenses page; the API would accept one. Keep it and build a record-only form, or withdraw it (SECURITY_PROGRAM.md §5).                                                                                                                                                                                                                                                                          |

## Test coverage

Run on 2026-09-28 against PostgreSQL 16:

- `npm test` — unit, no database: 57 suites, 870 tests. They include the
  shared package's money, permission and reminder specs, the sign-in lockout
  keys, the OAuth browser binding, the boot check, the backup and
  secret-scan tooling, and the Idempotency-Key coverage of every money route.
- `npm run test:integration -w @dentalcare/api` — against a real database as
  the real roles, from a fresh migration to 0026: 40 suites, 587 tests. They
  pass with the process clock on UTC, UTC+14 and Europe/Tirane.

The integration suites that carry the security claims above:

| Suite                                                               | Proves                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role.itest.ts`, `tenant-isolation.itest.ts`, `privileges.itest.ts` | RLS on every tenant table, cross-clinic reads and writes refused, revoked privileges stay revoked                                                                                              |
| `api-sessions.itest.ts`, `api-mfa.itest.ts`, `api-auth.itest.ts`    | Rotation, replay revocation, MFA enrolment and challenge with enforcement required                                                                                                             |
| `clinical-record.itest.ts`, `api-clinical.itest.ts`                 | No deletes, withdrawal with reason, signing locks, access log                                                                                                                                  |
| `money.itest.ts`                                                    | Cents, one currency per clinic, cancellation reverses the ledger                                                                                                                               |
| `api-inventory-lots.itest.ts`                                       | Lot balance at commit, recall refusals, who received a lot                                                                                                                                     |
| `reminders-delivery.itest.ts`                                       | SMS contents, skips, retries, opt-out, signed receipts that cannot cross clinics                                                                                                               |
| `tenant-middleware.itest.ts`                                        | The exact list of routes that run without a clinic                                                                                                                                             |
| `auth-lockout.itest.ts`                                             | A lockout set on one API process holds on another; unknown addresses lock the same way; one address spraying accounts is locked out                                                            |
| `money-idempotency.itest.ts`                                        | A repeated key replays; a rerun after a lost replay is refused by the unique index; no duplicate invoice, expense or adjustment. Every clinic route that moves money answers 428 without a key |
| `platform-billing.itest.ts`                                         | The console's billing refuses a request without a key, replays one with it, and audits the settlement once                                                                                     |
| `reception-money.itest.ts`                                          | Reception takes a payment but cannot void it or an expense, cannot list expenses, and still reads the chart                                                                                    |
| `clinic-day.itest.ts`                                               | Every date the API writes for "today" is the clinic's, when its clock and the server's disagree                                                                                                |
