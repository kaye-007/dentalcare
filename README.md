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

Requires Node 20+ and Docker.

```bash
cp .env.example .env          # Windows: Copy-Item .env.example .env
docker compose up -d postgres
npm install
npm run migrate:up            # also creates the app_user role
npm run seed                  # loads the demo clinic
```

If ports 3000 or 5432 are already in use on your machine, set `API_PORT` and
`POSTGRES_PORT` in `.env` — the containers are unaffected, only the host
bindings change.

Then, in three terminals:

```bash
npm run api:dev               # API on :3000
npm run web:dev               # clinic SPA on :5173
npm run admin:dev             # platform console on :5174
```

### Demo credentials

Created by `npm run seed`. Development only — the seed script refuses to run
against a production database.

| App | Email | Password |
|---|---|---|
| Clinic (`:5173`) | `demo@dentx.app` | `Demo@2026!` |
| Platform (`:5174`) | `admin@dentx.app` | `Demo@2026!` |

The demo clinic (`Demo Dental Clinic`, subdomain `demo`) ships with 25
patients, a full appointment calendar, a treatment catalogue, four months of
invoices, payments and expenses, and staff payroll.

```bash
npm run reset-demo            # wipe all tenant + platform data
npm run seed                  # reload the demo clinic
```

### Local tenant resolution

In production the clinic comes from the subdomain
(`demo.dentalcare.app` → `demo`). On localhost there is no subdomain, so the
API accepts an `X-Tenant-Subdomain` header — but only when
`ALLOW_TENANT_HEADER=1`, and never when `NODE_ENV=production`.

## Scripts

| Command | Description |
|---|---|
| `npm run api:dev` / `web:dev` / `admin:dev` | Development servers |
| `npm run api:build` / `web:build` / `admin:build` | Production builds |
| `npm test -w @dentalcare/api` | Test suite |
| `npm run migrate:up` / `migrate:down` | Database migrations |
| `npm run seed` | Load the demo clinic |
| `npm run reset-demo` | Wipe all data |
| `npm run bootstrap-admin` | Create the first platform admin (production) |

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
| [RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) | RC1 readiness |
| [CHANGELOG.md](docs/CHANGELOG.md) | Release history |
| [MASTER_REMEDIATION_PLAN.md](docs/MASTER_REMEDIATION_PLAN.md) | Prioritised technical debt |

## Tests

```bash
npm test -w @dentalcare/api
```

47 regression tests covering the configuration gate, tenant status
enforcement, subdomain resolution, token binding and cross-plane isolation,
role guards, and the data-script production guard. No database required.

## Licence

Proprietary — © NODE X.
