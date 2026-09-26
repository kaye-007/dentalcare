# DentalCare by NODE X

Multi-tenant clinic management SaaS for dental practices. One shared
deployment; each clinic is a tenant reached by its own subdomain. Internal
clinic-staff system — no patient portal.

Patients and the clinical record (odontogram, perio charting, signing) ·
scheduling and SMS reminders · treatment plans · invoicing, payments and the
patient ledger · inventory with lots and recalls · staff, payroll and
analytics · two-step sign-in.

## Apps

| Workspace | Purpose | Dev URL |
|---|---|---|
| `apps/api` | NestJS API — clinic plane + platform plane | http://localhost:3000 |
| `apps/tenant-web` | Clinic SPA (admin, dentist, hygienist, assistant, receptionist) | http://localhost:5173 |
| `apps/admin-web` | NODE X platform console | http://localhost:5174 |

**Stack.** NestJS 11 · PostgreSQL 16 (raw SQL, no ORM) · React 18 + Vite ·
JWT access tokens with rotating server-side sessions and TOTP · Cloudflare
Workers + Hyperdrive, or Docker. Money is integer minor units (cents) in one
currency per clinic.

## Two planes, two database roles

- **Clinic plane** runs as `app_user`, a non-superuser role. Row-Level
  Security is enforced on every table that carries a `tenant_id` (the
  integration suite reads the list from the catalogue) and scoped per request by
  `app.current_tenant_id`. Services never filter by `tenant_id` — the
  database does it.
- **Platform plane** (superadmin) uses the privileged connection because it
  must operate across all tenants. Reachable only behind the platform guard.

This is the core of the design. See [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting started

Requires Docker. Node 20+ as well if you want to work on the SPAs.

```bash
cp .env.example .env          # Windows: Copy-Item .env.example .env
npm run dev:up
```

That is the whole database setup. `dev:up` is `docker compose up -d --build`,
and compose runs three things in order: Postgres, then a one-shot `migrate`
container, then the API — which starts only once `migrate` has exited 0, so
the API can never come up against an unmigrated database. Re-run it as often
as you like; every step is a no-op when it has already happened.

Set `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` in `.env` before the
first `dev:up` and it also creates your platform console account. Otherwise:

```bash
npm run admin:create          # PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=...
```

Then sign in to the console on `:5174`, create your first clinic, and put its
subdomain in `DEV_TENANT_SUBDOMAIN` so `:5173` knows which clinic localhost
is. Migrations create schema only — the database starts with no data.

```bash
npm run dev:down              # stop everything, KEEP the database
npm run dev:reset             # stop everything, DELETE the database, start fresh
```

`dev:down` is `docker compose down`, which removes the containers and leaves
the `pgdata` volume alone: your clinics and patients are still there when you
come back. Only `dev:reset` (`docker compose down -v`) destroys it.

If ports 3000 or 5432 are already in use on your machine, set `API_PORT` and
`POSTGRES_PORT` in `.env` — the containers are unaffected, only the host
bindings change.

Then, in two terminals:

```bash
npm run web:dev               # clinic SPA on :5173
npm run admin:dev             # platform console on :5174
```

Both proxy `/api` to the API container. To run the API from source instead —
for a debugger, or to iterate on it — leave Postgres up and start it directly:

```bash
npm run api:dev               # API on :3000, using the HOST connection strings
```

### Running Postgres yourself

If you would rather not use compose for the database, `dev:setup` does the
same job against whatever `DATABASE_URL` points at:

```bash
npm run dev:setup             # database, app role, migrations — verified
npm run dev:setup:reset       # drop the database first, then all of the above
```

`dev:setup` is idempotent. It creates the database if missing, **converges the
app_user password to match .env** (a role outlives the database it was created
for, so a rebuilt database inherits a stale one), runs migrations, repairs
grants for any table created outside a migration, checks that the deliberate
revocations are still in place, and then proves the result by connecting *as
the application role* and reading the data back.

If it prints `ready`, the app will run. If it fails, it names the step.

### Demo data (local development only)

```bash
npm run seed -w @dentalcare/api          # one clinic, twelve patients, a year of history
npm run reset-demo -w @dentalcare/api    # wipe tenant + platform data, keep the schema
```

The seed writes **documented credentials** (`demo@dentx.app`, and a platform
admin `admin@dentx.app`, both with the password printed at the end of the run).
Both `seed` and `reset-demo` refuse to run when `NODE_ENV=production` or
against a non-local database — see `scripts/lib/guard.js`.

> **Before a public release, decide whether these two scripts stay in the tree.**
> A previous cleanup pass deleted them precisely because they hard-code a
> password. That is a legitimate call; it was reverted because it also left no
> way to obtain a first login, and because it deleted `bootstrap-admin` along
> with them. If they are removed again, `bootstrap-admin` must stay — it ships
> no credentials, and `docs/DEPLOYMENT.md` § First platform administrator is
> written against it.

For a real deployment use `bootstrap-admin` instead, which writes only the one
account you give it:

```bash
PLATFORM_ADMIN_EMAIL=you@company.com \
PLATFORM_ADMIN_PASSWORD=a-long-random-password \
npm run bootstrap-admin -w @dentalcare/api
```

### Local tenant resolution

In production the clinic comes from the subdomain
(`acme.dentalcare.app` → `acme`). On localhost there is no subdomain, so the
API accepts an `X-Tenant-Subdomain` header — but only when
`ALLOW_TENANT_HEADER=1`, and never when `NODE_ENV=production`.

## Scripts

| Command | Description |
|---|---|
| `npm run api:dev` / `web:dev` / `admin:dev` | Development servers |
| `npm run api:build` / `web:build` / `admin:build` | Production builds |
| `npm test -w @dentalcare/api` | Unit tests, no database |
| `npm run test:integration -w @dentalcare/api` | Integration tests against Postgres |
| `npm run cf:check-caching -w @dentalcare/api` | Ask Cloudflare whether both Hyperdrive configs have caching disabled |
| `npm run migrate:up` / `migrate:down` | Database migrations |
| `npm run migrate:create` | Scaffold a new migration |

## Configuration

`.env.example` for development, `.env.production.example` for deployment.
The API validates configuration at boot and **refuses to start** on an
invalid one rather than running unsafely — most importantly, it will not
start in production without `APP_DATABASE_URL`, or if that role can bypass
Row-Level Security. Production also requires `PLATFORM_JWT_SECRET`,
`MFA_ENCRYPTION_KEYS` and `MFA_ENFORCEMENT=required`. SMS is off until
`SMS_PROVIDER=twilio` and its credentials are set.

Full reference: [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Deployment

Two runtimes from one codebase, chosen by `RUNTIME`:

- **Cloudflare Workers** (`RUNTIME=workers`): the API as a Worker behind two
  Hyperdrive configs, the SPAs as static-asset Workers, reminders on a Cron
  Trigger. Scales horizontally. Configured in `apps/api/wrangler.jsonc`.
- **Container** (`RUNTIME=node`, the default): `infra/docker/`. Resident
  connection pools and an in-process reminder scheduler, so it runs as **one
  replica**.

Which one is the primary production target is still an open decision. Both
build and pass the test suites; neither has served real clinic traffic. See
[DEPLOYMENT.md](docs/DEPLOYMENT.md), and its staging checklist before believing
either.

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, tenancy model, data model |
| [PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md) | Folder map and conventions |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment, configuration, scaling limits |
| [SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) | Findings, fixes, what remains |
| [CHANGELOG.md](docs/CHANGELOG.md) | Release history |
| [RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) | Historical RC1 readiness record |

## Tests

```bash
npm test -w @dentalcare/api                    # unit — no database
npm run test:integration -w @dentalcare/api    # against Postgres, as the real roles
```

Unit: 26 suites, 541 tests — configuration gates, permissions, money, the
billing, stock and lot engines, TOTP and session tokens, reminder wording and
delivery policy. Integration: 22 suites, 355 tests — tenant isolation and
privileges, sessions and MFA, the clinical record, money, inventory lots and
SMS delivery, each against a real database. Figures from 2026-09-14.

## Licence

Proprietary — © NODE X.
