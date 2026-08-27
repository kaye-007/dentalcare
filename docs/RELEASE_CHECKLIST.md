# Release Checklist — RC1

> **Historical document — the access model has changed twice since this was written.**
> Roles here are the pre-0012 `owner` / `frontdesk` pair. Migration 0012 replaced them with
> `admin` / `dentist` / `receptionist`, and migration 0017 collapsed those to `admin` (the
> doctor) and `receptionist`. Read `apps/api/src/core/authz/permissions.ts` for what is
> actually enforced; nothing on this page should be used to reason about current access.


> **HISTORICAL RECORD — superseded.** This documents the RC1 demonstration
> build as it stood before the cleanup pass. The demo tooling it describes
> (`npm run seed`, `npm run reset-demo`, `npm run bootstrap-admin`,
> `apps/api/scripts/`) **no longer exists**, and neither do the fixture
> accounts and credentials listed below. Kept for the readiness assessment
> and the deviation notes; do not follow its commands.

DentalCare by NODE X · first public demonstration build.

**Release Readiness: 7.5 / 10** — ready to demonstrate to dental clinics.
Not yet ready to onboard them as paying customers. Reasoning at the end.

---

## ✅ Demo account

| App | Email | Password | Role |
|---|---|---|---|
| Clinic — `demo.<host>` or `:5173` | `demo@dentx.app` | `<redacted>` | Owner |
| Platform console — `:5174` | `admin@dentx.app` | `<redacted>` | Platform admin |

Additional clinic staff, all `<redacted>`, for demonstrating permissions:

| Name | Email | Access | Position |
|---|---|---|---|
| Dr. Lukas Brandt | `l.brandt@dentx.app` | Owner | Dentist |
| Dr. Sofia Ricci | `s.ricci@dentx.app` | Frontdesk | Dentist |
| Dr. Julien Moreau | `j.moreau@dentx.app` | Frontdesk | Orthodontist |
| Marta Novák | `m.novak@dentx.app` | Frontdesk | Receptionist |
| Ana Silva | `a.silva@dentx.app` | Frontdesk | Dental Assistant |

> **Deviation from spec.** The brief asked for a "Super Administrator" role
> within the demo tenant. The schema permits exactly two clinic roles —
> `users_role_check CHECK (role IN ('owner','frontdesk'))`. Adding a third
> tier is a schema and permission-model change, which this mission excludes.
> The demo owner has the highest access the product offers.

**Credentials no longer appear in the UI.** Both login pages rendered them as
hardcoded hints; they now render only under `import.meta.env.DEV`, so a
production demo build shows none.

## ✅ Demo clinic

**Demo Dental Clinic** · subdomain `demo` · Mariahilfer Straße 88, Vienna ·
Professional plan.

| | |
|---|---|
| Staff | 6 (2 owners, 4 frontdesk) with positions and monthly salaries |
| Patients | 25, realistic European names, contact details, birth dates |
| Appointments | 215 — eight weeks of history, two weeks ahead |
| Treatments | 14, priced €40–€1,450 |
| Invoices | 140 with line items; 130 payments across card/bank/cash |
| Expenses | 20 across rent, materials, lab, utilities, other |
| Payroll | 3 months of salary payments |
| Records | Odontogram entries and clinical notes |
| Reminders | 12 sent reminders in the log |

Financials read as a healthy practice: **€90,640 invoiced, €72,939
collected, €20,525 expenses, €52,414 profit, €14,355 outstanding**, with a
six-month trend chart.

Output is seeded pseudo-random, so the clinic has the same shape on every
run — a demo that reshuffles between runs is hard to script a walkthrough
around.

```bash
npm run reset-demo    # wipe everything
npm run seed          # reload the demo clinic
```

## ✅ Data wipe confirmation

The previous seed created two fictional clinics (Avicena Clinic, Smile
Studio) with README-published passwords, plus a superadmin on
`admin@nodex.al / Admin123!`. **All removed** — `scripts/seed.js` is deleted.

Migrations contained **no** demo data; they are pure schema. Nothing had to
be moved out of them into optional seed files.

`npm run reset-demo` truncates all 14 tenant tables plus `audit_log` and
`platform_admins`. Subscription `plans` are preserved as application
configuration (pass `--plans` to clear those too).

Both data scripts share one production guard and refuse to run when
`NODE_ENV=production`, when the host or database name contains `prod`, or
against a non-local host without an explicit override.

**A demo-breaking bug was caught during this sweep:** the SPA still defaulted
`VITE_TENANT_SUBDOMAIN` to `avicena`, a clinic that no longer exists — every
request would have 404'd. Fixed here, and in `.env.example` and
`docker-compose.yml`.

## ✅ Currency migration summary

> **The product was never denominated in USD.** It used Albanian Lekë
> (`formatLek()` → `"5,000 L"`), and there was no multi-currency system. So
> nothing was "switched from USD", and nothing that was already configurable
> was hardcoded.

| Area | Before | After |
|---|---|---|
| Formatter | `formatLek()`, `toLocaleString('en-US') + " L"` | `formatMoney()` via `Intl.NumberFormat('de-DE', EUR)` |
| Call sites | 44 across 7 pages | renamed, unchanged behaviour |
| Input labels | 7 × "(Lekë)" | "(€)" |
| Settings copy | "Currency is Lekë (ALL)" | "Currency is Euro (EUR)" |
| API message | "outstanding balance (… L)" | "… EUR" |
| Demo prices | Lekë-scale (15,000) | euro-scale (€450) |

**Stored integers remain whole currency units.** A stored `4500` renders as
€4,500 — not €45.00. Reinterpreting them as minor units would have divided
every historical amount by 100: a silent data corruption, not a formatting
change. `CURRENCY`, `CURRENCY_SYMBOL`, and `CURRENCY_LABEL` are exported from
one module, so a future multi-currency feature has a single seam.

Applied migration comments still read "Lekë". Those are immutable history and
were deliberately left alone.

## ✅ Development settings removed

Audited; the codebase was already clean of these.

| Sought | Found |
|---|---|
| Development banners | None |
| Test flags / feature flags | None |
| Debug endpoints | None |
| Experimental configuration | None |
| Developer-only scripts | `seed.js` — removed |
| Temporary logging | None. Pino's `debug` level in development and `info` in production is intended behaviour, not debug residue. |

Removed in the preceding hardening branch: an orphaned submodule gitlink and
an unused Redis service.

**Fixed during verification:** the reports endpoint issued six queries
concurrently via `Promise.all` on a single `PoolClient`. node-postgres runs
them serially regardless, and concurrent use is removed in `pg@9`. Now
sequential — identical work, and the server log is clean.

## ✅ Branding

- Neither SPA had a favicon; browsers 404'd on `/favicon.ico`. Added SVG
  marks derived from the in-app logo — teal on tint for the clinic app,
  inverted for the platform console.
- Added `description` and `theme-color`; the platform console is
  `noindex, nofollow`.
- Product name standardised as **DentalCare · NODE X**, consistent across
  README, `package.json`, titles, and the UI. No placeholder logos or
  temporary titles were found.

> **Open question.** The specified demo domain is `dentx.app`, which suggests
> the product may be branded **DentX**. Renaming from DentalCare is a brand
> decision, not a cleanup one, so it was not made unilaterally. Say the word
> and it is a small change.

## ✅ Deployment readiness

| Check | Result |
|---|---|
| API build | `nest build` — clean |
| Clinic SPA build | 1594 modules, 277 kB (79 kB gzip) |
| Platform SPA build | 1580 modules, 181 kB (58 kB gzip) |
| Docker image | Multi-stage, non-root `node` user, migrations included |
| `docker compose config` | Valid; fails loudly without `JWT_SECRET` |
| Migrations | 11, applied cleanly to an empty database |
| Seed | Runs, idempotent on re-run |
| Health check | `GET /api/health` → `{"status":"ok","database":"up"}` |
| Build warnings | None |
| Server warnings/errors | None |

Configuration fails fast: the API refuses to start in production without
`APP_DATABASE_URL`, if that role can bypass RLS, or with a weak or
placeholder `JWT_SECRET`. Templates in `.env.example` and
`.env.production.example`; deployment blueprints in `render.yaml` and
`apps/*/vercel.json`.

## ✅ GitHub readiness

| Check | Result |
|---|---|
| README | Rewritten — accurate stack, install, demo credentials, scripts |
| Installation guide | In README, verified end to end from an empty database |
| Deployment guide | `DEPLOYMENT.md` |
| Environment documentation | `.env.example`, `.env.production.example`, `DEPLOYMENT.md` |
| Architecture documentation | `ARCHITECTURE.md`, `PROJECT_STRUCTURE.md` |
| Secrets committed | None. `.env` is gitignored; only placeholder examples are tracked. |
| Local paths | None in source |
| Build artefacts | `dist/`, `node_modules/`, `coverage/` ignored and untracked |
| `.gitignore` | Covers build output, env files, editor settings |
| Commit history | 15 focused commits, each independently revertible |

## ✅ Final verification

Run against a freshly migrated and seeded database.

| Area | Result |
|---|---|
| Login (owner, frontdesk, platform) | ✅ |
| Invalid password | ✅ 401 |
| `/auth/me` | ✅ |
| Token refresh | ✅ new access token issued |
| Password change | ✅ wrong 401 · reuse 400 · valid 200 · revert 200 |
| Logout | ✅ client-side token clear |
| Dashboard | ✅ 25 patients, live finance summary |
| Patients | ✅ list, pagination, search |
| Appointments | ✅ 215 across the calendar |
| Invoices | ✅ 140 with line items, payments, balances |
| Reports | ✅ totals, six-month trend, breakdowns by treatment/dentist/method |
| Reminders | ✅ 12 in the log |
| Authorization | ✅ reports and settings 200 owner / 403 frontdesk |
| Payroll visibility | ✅ stripped server-side for frontdesk |
| Tenant isolation | ✅ unknown subdomain 404; no token 401 |
| Archived tenant | ✅ 403 on login and data; restored on reactivation |
| Suspended tenant | ✅ 403 |
| Rate limiting | ✅ 429 after the configured ceiling |
| Security headers | ✅ HSTS, nosniff, frame options, referrer policy |
| Console/server errors | ✅ none |

---

## ⚠️ Remaining known issues

Nothing here blocks a demonstration. Several block onboarding real clinics.

### Blocks paying customers

1. **Single replica only.** The reminder scheduler runs in-process with no
   distributed lock. `render.yaml` pins `numInstances: 1`. Extracting it to a
   single-replica worker is the highest-leverage remaining change.
2. **No refresh-token rotation or revocation.** A stolen refresh token stays
   valid seven days; logout is client-side only.
3. **No backups configured or restore rehearsed.** Non-negotiable before real
   patient data.
4. **No CI.** Tests exist but nothing runs them automatically.
5. **No clinic-plane audit trail.** `audit_log` covers platform actions only —
   there is no record of who read or changed a medical record, which is
   commonly expected for health data.

### Should fix soon

6. One `JWT_SECRET` shared across both planes.
7. Platform plane uses the migration superuser rather than a least-privilege
   role (documented in the code as an MVP shortcut).
8. Tokens in `localStorage` — XSS-reachable without a strong CSP.
9. Reminder messages write patient names to server logs.
10. List endpoints other than patients are capped, not paginated — an
    established clinic will silently hit the ceiling.
11. Patient search uses `ILIKE '%…%'` with no trigram index.

### Cosmetic

12. The topbar search input is inert. Visible in a demo — consider hiding it
    until wired.
13. `private tx()` is duplicated across 7 services; deliberately deferred
    until service-level test coverage exists.

### ⚠️ Repository divergence — read before pushing

This repository is a **snapshot that diverges from another copy of the
project**. The Docker container currently running on this machine was built
from `Downloads/dentalcare-m16/dentalcare`, which has **32 migrations to this
repository's 11**, 73 API source files to 44, and 12 commits of feature
history to this repository's one. **The two have unrelated git histories.**
That copy contains features absent here entirely — MFA, inventory, patient
images, treatment plans, platform backups.

**This repository holds the GitHub remote (`kaye-007/dentalcare`); that one
has none.** Pushing this branch would publish a snapshot missing roughly two
months of work as the canonical repository.

You were informed of this and chose to continue in this copy, which is
respected — but reconcile the two before pushing or demonstrating anything
built from the other tree.

---

## Score: 7.5 / 10

**What earns it.** Tenant isolation is enforced in PostgreSQL rather than
trusted to application code, and that was verified table by table. Every
security fix has a regression test. The whole surface was exercised end to
end against a real database, not assumed. Configuration fails fast on exactly
the mistakes that would be catastrophic. The demo clinic looks like a real
practice and its numbers hold up under questioning. Builds are clean, logs
are clean, deployment is documented and reproducible.

**What holds it back.** Single-replica constraint, no token revocation, no
backups, no CI, and no clinical audit trail. These are onboarding blockers,
not demo blockers — a clinic watching a walkthrough will not encounter any of
them, but the first clinic to sign up will.

**Recommendation.** Demonstrate with confidence. Before the first paying
clinic, work items 1–5 above; that is roughly a week and would move this to a
9.
