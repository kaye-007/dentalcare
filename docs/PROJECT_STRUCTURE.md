# Project Structure

npm workspaces: one API and two React SPAs.

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
│   ├── authz/              permission matrix, guard, decorator, route-coverage test
│   ├── audit/              clinic audit trail (append-only)
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
├── styles.css              single stylesheet, no CSS framework
├── lib/
│   ├── api.ts              typed API client, token store, silent refresh
│   ├── auth.tsx            AuthProvider, useAuth, RequireAuth
│   ├── format.ts           currency, initials, avatar tints
│   ├── permissions.ts      client-side mirror of the server matrix
│   ├── tooth-notation.ts   FDI / Universal mapping
│   └── i18n/               en + sq dictionaries
├── components/             AppLayout, ui.tsx primitives, and feature cards
└── pages/                  route components
```

State management is deliberately plain: React Context for auth, `useState` +
`useEffect` per page. No Redux, no React Query. At this size that is the right
call.

`admin-web` follows the same shape at a tenth of the size.

**This tree has not been through the domain-feature reorganization the API just
had.** `lib/api.ts` is a single 1,800-line client covering every domain, and
`components/` mixes generic primitives with feature-specific cards. The target
is `components/ui/`, `components/layout/`, and `features/<domain>/` with its own
`components/`, `hooks/`, `api/` and `types/`. Note that neither SPA has tests, so
that pass is guarded by `tsc` alone.

## Both SPAs call `/api/*` as a relative path

This is a deployment constraint, not a detail. Locally the Vite dev proxy
forwards to `:3000`; in production each SPA's Worker forwards `/api/*` to the
API Worker over a service binding. Same-origin is what lets the API resolve the
clinic from the `Host` subdomain — see [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Where to start reading

1. `apps/api/src/core/tenancy/` — how a request becomes a tenant
2. `apps/api/migrations/0003_tenant-isolation.js` — how isolation is enforced
3. `apps/api/src/core/database/database.service.ts` — the two planes
4. `apps/api/src/modules/clinic/finance/` — one feature end to end
5. `apps/tenant-web/src/lib/api.ts` — the client contract
