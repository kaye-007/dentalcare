# Project Structure

npm workspaces: one API, two React SPAs, and the package they share.

```
apps/api            NestJS modular monolith + migrations
apps/tenant-web     the clinic's app
apps/admin-web      the vendor console
packages/shared     contracts both planes depend on (see below)
infra/docker        Dockerfile + compose for local Postgres and the API
scripts/            repo-level tooling: dev-setup, doctor, smoke, class audit
docs/               this file and its neighbours
```

Anything else at the root is generated and gitignored — `node_modules/`,
`dist/`, `.wrangler/`, `_to_delete/`. Nothing in the build reads from them.

## packages/shared

The rules that both sides must agree on, and that were duplicated until they
drifted: `permissions` (the role matrix), `tooth-notation` (FDI, surfaces,
Universal), `money`, `vat`, `features`, `cash-drawer`, `messages`,
`reminders`, `csv`, `patient-import`, plus `api-types`.

Each carries its own `*.spec.ts`. Those specs run inside the API's jest run
rather than a second runner — `apps/api/jest.config.js` lists
`packages/shared/src` among its roots — so a contract change fails in the
suite that already tests the code depending on it.

## apps/api

```
src/
├── main.ts                 Node entrypoint (container / local dev)
├── bootstrap.ts            configureApp() — the middleware both runtimes share
├── app.module.ts           composition root: wires modules, mounts TenantMiddleware
│
├── core/                   app-wide infrastructure. No domain logic lives here.
│   ├── config/             env schema (zod) — the app refuses to boot on a bad one
│   ├── database/           DatabaseService: the two planes, both runtimes
│   ├── tenancy/            tenant resolution, request context, read-only guard
│   ├── authz/              permission guard, decorator, route-coverage test
│   ├── audit/              clinic audit trail (append-only)
│   ├── sessions/           server-side session state, forward-only
│   ├── mfa/                TOTP enrolment and recovery codes
│   ├── idempotency/        Idempotency-Key claim/replay interceptor
│   ├── request-context/    ALS: request id, IP, user agent
│   ├── entitlements/       plan + override resolution behind feature flags
│   ├── money/              minor-unit arithmetic at the edges
│   ├── pdf/                invoice and receipt rendering
│   ├── oauth/              Google sign-in: strategy, guards, callback controller
│   ├── storage/            S3-compatible object storage over aws4fetch
│   ├── security/           bcrypt wrapper
│   └── health/             GET /api/health
│
├── shared/                 cross-cutting; no single module owns it
│   ├── decorators/         @CurrentUser
│   └── types/              AccessTokenPayload, RequestWithUser
│
└── modules/                domain features, split by PLANE first
    ├── clinic/             RLS enforced — connects as app_user
    │   ├── auth/  users/  patients/  patient-history/  documents/
    │   ├── appointments/  scheduling/  staff/  treatments/  charting/
    │   ├── perio/  treatment-plans/  settings/  finance/  billing/
    │   ├── cash-drawer/  fiscalization/  features/  inventory/
    │   └── reports/  analytics/  reminders/  audit/
    └── platform/           privileged — bypasses RLS by design
        └── auth/  tenants/  plans/  audit/
```

**The plane is the security boundary, so it is the first thing in the path.**
`modules/clinic/*` runs as `app_user`, which the baseline migration creates
`NOSUPERUSER … NOBYPASSRLS`. `modules/platform/*` connects with the privileged
role, because the vendor console has to see across every clinic. A flat
`modules/<domain>` would make those two indistinguishable at a glance — not a
property you want in the directory tree that decides who can read whose medical
records.

### Inside a module

```
modules/clinic/finance/
├── index.ts                     public surface — what other modules may import
├── finance.module.ts            wiring only
├── finance.service.ts           business logic
├── invoices.controller.ts       HTTP routing, one file per resource root
├── payments.controller.ts
├── expenses.controller.ts
├── finance-summary.controller.ts
├── billing-engine.ts            pure calculation, unit-tested in isolation
└── dto/finance.dto.ts           class-validator request schemas
```

Controllers route and nothing more; the service holds the logic. Some modules
also carry `<domain>.types.ts` — the domain vocabulary (`PERIO_SITES`,
`DOCUMENT_KINDS`, `WorkingDay`) that both the service and its DTOs need. That is
a separate file for a concrete reason: while the vocabulary lived in the
service, the DTO imported the service and the service imported the DTO, and a
cycle like that resolves to `undefined` at runtime for whichever side loads
second.

**There is no `entities/` folder.** There is no ORM either. Tables and their RLS
policies are defined in `apps/api/migrations/*.js`; TypeScript only ever sees
query results, and those row types sit beside the service that maps them. An
`entities/` folder would describe a layer this application does not have.

### Imports

`@/*` maps to `src/*` — declared in `tsconfig.json` paths, mirrored in
`jest.config.js` `moduleNameMapper`, and rewritten to plain relative paths at
build time by `tsc-alias` so the emitted `dist/` runs unaided in both the
container and the Worker bundle.

- Inside a module — relative: `./finance.service`
- Across modules — the barrel: `@/modules/clinic/finance`
- Into core or shared — the file: `@/core/database/database.service`

Reaching past a barrel into another module's internals is the thing to avoid.
The barrel is the contract; `index.ts` exports only what something outside the
folder actually imports.

Tests live beside their subject as `*.spec.ts` and are excluded from the
production build via `tsconfig.json`.

## apps/tenant-web

```
src/
├── App.tsx                 routes; everything but /login sits behind RequireAuth
├── main.tsx
├── styles.css              the bulk of it; no CSS framework
├── messaging.css           screens too large to leave in styles.css:
├── drawer.css                the message threads, the cash drawer,
├── operations.css            the operational tables,
├── print.css                 and what a printed document looks like
├── lib/
│   ├── api.ts              typed API client, token store, silent refresh
│   ├── auth.tsx            AuthProvider, useAuth, RequireAuth
│   ├── features.tsx        entitlement lookup for the current clinic
│   ├── format.ts           currency, dates, initials, avatar tints
│   ├── permissions.ts      how this app TALKS about the shared matrix
│   ├── tooth-notation.ts   how the odontogram DRAWS a finding
│   └── strings.ts          user-facing copy
├── components/             AppLayout, ui.tsx primitives, and feature cards
└── pages/                  route components
```

State management is deliberately plain: React Context for auth, `useState` +
`useEffect` per page. No Redux, no React Query. At this size that is the right
call.

`admin-web` follows the same shape at a tenth of the size.

**This tree has not been through the domain-feature reorganization the API
had.** `lib/api.ts` is a single ~3,400-line client covering every domain, and
`components/` mixes generic primitives with feature-specific cards — though the
two largest groupings have since moved into `components/drawer/` and
`components/settings/`. The target is `components/ui/`, `components/layout/`,
and `features/<domain>/` with its own `components/`, `hooks/`, `api/` and
`types/`.

Neither SPA has a test runner, so that pass is guarded by `tsc` and by
`npm run audit:classes`, which fails on a class used in JSX with no CSS rule
and on a rule nothing uses. It is the only automated check on the stylesheets.

## Both SPAs call `/api/*` as a relative path

This is a deployment constraint, not a detail. Locally the Vite dev proxy
forwards to `:3000`; in production each SPA's Worker forwards `/api/*` to the
API Worker over a service binding. Same-origin is what lets the API resolve the
clinic from the `Host` subdomain — see [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Where to start reading

1. `apps/api/src/core/tenancy/` — how a request becomes a tenant
2. `apps/api/migrations/0001_baseline.js` — the schema and how isolation is
   enforced; `0002`+ are the changes since
3. `apps/api/src/core/database/database.service.ts` — the two planes
4. `apps/api/src/modules/clinic/finance/` — one feature end to end
5. `apps/tenant-web/src/lib/api.ts` — the client contract
