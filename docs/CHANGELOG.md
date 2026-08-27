# Changelog

All notable changes to this project. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — production-hardening branch

### Cleanup pass

Repository hygiene and removal of all demo/fixture tooling. **No feature was
added or removed; no business logic or database schema changed.** Full test
suite and all three builds verified green afterwards.

- **Removed `apps/api/scripts/` entirely** — `seed-demo.js`, `reset-demo.js`,
  `bootstrap-admin.js`, `lib/guard.js` and their specs. The repository now
  ships no fixture data and no credentials. The first platform administrator
  is created by hand; see DEPLOYMENT.md.
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
side-effect imports, subpath imports, or peer dependencies. See
[`REMOVED_DEPENDENCIES.md`](REMOVED_DEPENDENCIES.md).

### Documentation

`ARCHITECTURE.md`, `PROJECT_STRUCTURE.md`, `SECURITY_AUDIT.md`,
`CLEANUP_REPORT.md`, `REMOVED_FILES.md`, `REMOVED_DEPENDENCIES.md`,
`DEPLOYMENT.md`, `MASTER_REMEDIATION_PLAN.md`.

### Known limitations

- **The API must run at exactly one replica.** The reminder scheduler has no
  distributed lock. Extracting it to a single-replica worker is the highest
  -leverage remaining change. `render.yaml` pins `numInstances: 1`.
- No refresh-token rotation or revocation; logout is client-side only.
- One `JWT_SECRET` shared across both planes.
- No CI pipeline. Tests exist but nothing runs them automatically.

---

## [0.1.0] — prior

Milestones M1–M10 plus two correction passes: app shell, auth and roles,
tenant isolation with RLS, superadmin tenant management, patients,
reservations, treatments and medical records, staff and settings, invoices
and payments, reports, and reminders. See `README.md`.
