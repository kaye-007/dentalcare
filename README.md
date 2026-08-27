# DentalCare by NODE X

Multi-tenant clinic management SaaS for dental practices. One shared
deployment; each clinic is a tenant reached by its own subdomain. Internal
clinic-staff system — no patient portal.

Patients · scheduling · treatments & odontogram · staff and payroll ·
invoicing & payments · expenses · owner analytics · appointment reminders.

## Apps

| Workspace | Purpose | Dev URL |
|---|---|---|
| `apps/api` | NestJS API — clinic plane + platform plane | http://localhost:3000 |
| `apps/tenant-web` | Clinic SPA (owner / frontdesk) | http://localhost:5173 |
| `apps/admin-web` | NODE X platform console | http://localhost:5174 |

**Stack.** NestJS 10 · PostgreSQL 16 (raw SQL, no ORM) · React 18 + Vite ·
JWT auth · Docker. Money is stored as integers in whole euros.

## Two planes, two database roles

- **Clinic plane** runs as `app_user`, a non-superuser role. Row-Level
  Security is enforced on all 14 tenant tables and scoped per request by
  `app.current_tenant_id`. Services never filter by `tenant_id` — the
  database does it.
- **Platform plane** (superadmin) uses the privileged connection because it
  must operate across all tenants. Reachable only behind the platform guard.

This is the core of the design. See [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting started

Requires Node 20+ and Postgres (local install or `docker compose up -d postgres`).

```bash
cp .env.example .env          # Windows: Copy-Item .env.example .env
npm install
npm run dev:setup             # database, app role, migrations, demo data — verified
```

`dev:setup` is idempotent: run it as often as you like. It creates the database
if missing, **converges the app_user password to match .env** (a role outlives
the database it was created for, so a rebuilt database inherits a stale one),
runs migrations, re-applies grants, seeds, and then proves the result by
connecting *as the application role* and reading the data back. Add `--reset`
to drop the database first:

```bash
npm run dev:reset
```

If it prints `ready`, the app will run. If it fails, it names the step.

Migrations create schema only — they contain no data. The database starts
empty; create your first platform administrator as described in
[DEPLOYMENT.md § First platform administrator](docs/DEPLOYMENT.md#first-platform-administrator),
then create clinics from the platform console on `:5174`.

If ports 3000 or 5432 are already in use on your machine, set `API_PORT` and
`POSTGRES_PORT` in `.env` — the containers are unaffected, only the host
bindings change.

Then, in three terminals:

```bash
npm run api:dev               # API on :3000
npm run web:dev               # clinic SPA on :5173
npm run admin:dev             # platform console on :5174
```

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
| `npm test -w @dentalcare/api` | Test suite |
| `npm run migrate:up` / `migrate:down` | Database migrations |
| `npm run migrate:create` | Scaffold a new migration |

## Configuration

`.env.example` for development, `.env.production.example` for deployment.
The API validates configuration at boot and **refuses to start** on an
invalid one rather than running unsafely — most importantly, it will not
start in production without `APP_DATABASE_URL`, or if that role can bypass
Row-Level Security.

Full reference: [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Deployment

Frontends on Vercel; the API as a Docker container on Render, Railway, or a
VPS. The API is a long-running process with a resident scheduler and
persistent connection pools — it is deliberately not serverless.

**The API must currently run at exactly one replica** — the reminder
scheduler has no distributed lock. See
[DEPLOYMENT.md](docs/DEPLOYMENT.md#scaling-beyond-one-instance).

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
npm test -w @dentalcare/api
```

36 regression tests across 3 suites, covering the configuration gate, tenant
status enforcement, subdomain resolution, token binding and cross-plane
isolation, and role guards. No database required.

## Licence

Proprietary — © NODE X.
