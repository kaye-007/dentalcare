# Security Audit

Audit of the DentalCare API and SPAs, with the remediation applied on the
`production-hardening` branch. Findings are carried forward from
[`MASTER_REMEDIATION_PLAN.md`](MASTER_REMEDIATION_PLAN.md); this document
records what was fixed, how it was verified, and what remains.

**Scope:** this repository snapshot. See the note at the end of
[`CLEANUP_REPORT.md`](CLEANUP_REPORT.md) regarding a divergent copy of the
project.

---

## Fixed

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
   refused. A *correct* URL pointing at a *privileged* role defeats RLS just
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

**Now eliminated at the root.** The cleanup pass deleted `apps/api/scripts/`
entirely — `seed-demo.js`, `reset-demo.js`, `bootstrap-admin.js` and the
shared guard. No script in this repository writes credentials, and no
credential appears anywhere in the tree. The first platform administrator is
created by hand; see
[DEPLOYMENT.md § First platform administrator](DEPLOYMENT.md#first-platform-administrator).
This finding is closed by removal rather than by control.

**Verified.** 9 tests in `seed.spec.ts` covering every refusal path and the
override; manually exercised all four cases against the CLI.

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
*absence* of `NODE_ENV=production`. A deploy missing one variable quietly
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

- **RLS coverage is complete.** All 14 tenant tables carry `ENABLE` + `FORCE
  ROW LEVEL SECURITY` and an identical `tenant_isolation` policy. Confirmed
  table by table, not inferred from migration comments.
- **Cross-plane token confusion is blocked both ways.** A platform token has
  no `tenantId` (rejected by `JwtAuthGuard`); a clinic token has no
  `scope: 'platform'` (rejected by `PlatformJwtGuard`). Both directions now
  have tests.
- **`tenants` policy omits `WITH CHECK` — this is safe.** PostgreSQL reuses
  the `USING` expression for new rows when `WITH CHECK` is absent.
- **Platform tables are protected.** Migration `0004` explicitly `REVOKE`s
  `app_user` from `platform_admins` and `audit_log`.
- **Authorization is server-enforced, not UI-only.** Every client-side
  `isOwner` gate has a corresponding `OwnerGuard` on the route. `StaffService`
  strips payroll fields server-side for non-owners.
- **"Owner-only pricing"** means editing. Frontdesk reading the catalog is
  intended and consistent across guard, service, and UI.

---

## Outstanding

Not addressed here. Rationale and estimates in
[`MASTER_REMEDIATION_PLAN.md`](MASTER_REMEDIATION_PLAN.md).

| Severity | Issue | Note |
|---|---|---|
| Medium | No refresh-token rotation or revocation | A stolen refresh token stays valid 7 days. Logout is client-side only. Needs server-side `jti` storage — a design change, not a patch. |
| Medium | Single `JWT_SECRET` across both planes | A leak compromises clinic and platform planes together. Split into `PLATFORM_JWT_SECRET`. |
| Medium | Tokens in `localStorage` | XSS-reachable. Acceptable with a strong CSP on the SPA host; otherwise httpOnly refresh cookie. |
| Medium | Platform plane uses the migration superuser | Documented in the code as an MVP shortcut. Should be a dedicated least-privilege role. |
| Medium | No clinic-plane audit trail | `audit_log` covers platform actions only. No record of who read or changed a medical record — commonly expected for health data. |
| Medium | PII in application logs | The reminder log channel writes patient name, appointment time, and reason to server logs. |
| Low | Migration `0003` interpolates the DB password into SQL | A production password containing a quote breaks or alters `CREATE ROLE`. Documented in `.env.production.example`. |
| Low | No dependency scanning in CI | `npm audit` reports advisories; no CI exists yet to gate them. |

## Test coverage

47 regression tests, no database required — `npm test -w @dentalcare/api`.
Each covers a behaviour change in a security-critical path and fails against
the pre-fix code.

| Suite | Tests | Covers |
|---|---|---|
| `env.validation.spec.ts` | 10 | Production config gate, secret strength |
| `tenant.middleware.spec.ts` | 15 | Status allowlist, header fail-closed, host parsing |
| `guards.spec.ts` | 13 | Token binding, cross-plane rejection, roles |
| `seed.spec.ts` | 9 | Every seed refusal path |
