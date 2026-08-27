# Project Structure

npm-workspace monorepo: one API, two SPAs. ~9,900 lines of application source.

```
dentalcare/
├── apps/
│   ├── api/                    @dentalcare/api — NestJS modular monolith
│   ├── tenant-web/             @dentalcare/tenant-web — clinic SPA  :5173
│   └── admin-web/              @dentalcare/admin-web — superadmin SPA :5174
├── docker-compose.yml          local Postgres + API
├── render.yaml                 API deployment blueprint
├── .env.example                local development
├── .env.production.example     production template
└── tsconfig.base.json          shared strict TypeScript config
```

## apps/api

```
apps/api/
├── migrations/                 node-pg-migrate, 0001–0011, schema only — no data
├── Dockerfile                  multi-stage; the deployment artefact
├── jest.config.js
└── src/
    ├── main.ts                 bootstrap: helmet, CORS, pipes, shutdown hooks
    ├── app.module.ts           module registry + tenant middleware wiring
    ├── core/                   cross-cutting, no business logic
    │   ├── config/             env schema + boot-time validation
    │   ├── database/           two pools, transaction helpers, RLS assertion
    │   ├── health/             GET /api/health
    │   ├── security/           bcrypt work factor
    │   └── tenancy/            subdomain → tenant, AsyncLocalStorage context
    ├── tenant/                 CLINIC PLANE — RLS-enforced, app_user role
    │   ├── auth/               login, refresh, password change, guards
    │   ├── users/              auth-time user lookups
    │   ├── patients/           patients + notes
    │   ├── appointments/       calendar, overlap protection
    │   ├── treatments/         catalog
    │   ├── medical-record/     per-tooth records (FDI)
    │   ├── staff/              team, positions, payroll
    │   ├── finance/            invoices, payments, expenses
    │   ├── reports/            owner-only analytics
    │   ├── settings/           clinic profile, hours, preferences
    │   └── reminders/          scheduler + channel abstraction
    └── platform/               PLATFORM PLANE — privileged, bypasses RLS
        ├── platform-auth/      superadmin login + guard
        ├── tenants/            create / list / suspend clinics
        ├── plans/              subscription tiers
        └── audit/              append-only platform action log
```

**The `tenant/` ÷ `platform/` split is the most important thing in the tree.**
They use different database credentials, different guards, and different token
scopes. `core/` is shared by both and contains no business logic. Nothing in
`tenant/` may import from `platform/`, or the reverse.

### Module convention

Most feature modules declare their controller, service, and DTOs **inside
`*.module.ts`** rather than in separate files. This is unconventional for
NestJS, but it is applied consistently and each file stays readable.

Three modules predate the convention and use separate files: `auth`,
`patients`, `appointments`. Splitting the rest is tracked as a low-priority
refactor — deliberately sequenced *after* test coverage exists, since churning
the layout without service-level tests trades real risk for stylistic gain.

Tests live beside their subject as `*.spec.ts` and are excluded from the
production build via `tsconfig.json`.

## apps/tenant-web

```
src/
├── App.tsx                 routes; everything but /login sits behind RequireAuth
├── main.tsx
├── styles.css              single stylesheet, ~500 lines, no CSS framework
├── lib/
│   ├── api.ts              typed API client, token store, silent refresh
│   ├── auth.tsx            AuthProvider, useAuth, RequireAuth
│   └── format.ts           currency, initials, avatar tints
├── components/
│   ├── AppLayout.tsx       sidebar, topbar, role-filtered navigation
│   ├── ui.tsx              Avatar, StatusPill, PageHeader, EmptyState, Modal
│   ├── PatientPicker.tsx
│   └── MedicalRecordCard.tsx
└── pages/                  13 route components
```

State management is deliberately plain: React Context for auth, `useState` +
`useEffect` per page. No Redux, no React Query. At this size that is the right
call — adding a data layer would be complexity without a problem to solve.

`admin-web` follows the same shape at a third of the size (3 pages).

## Both SPAs call `/api/*` as a relative path

This is a deployment constraint, not a detail. Locally the Vite dev proxy
forwards to `:3000`; in production a Vercel rewrite does the same. Keeping the
SPA and API same-origin is what allows `CORS_ORIGINS` to stay unset. See
[`DEPLOYMENT.md`](DEPLOYMENT.md).

## Where to start reading

1. `apps/api/src/core/tenancy/` — how a request becomes a tenant
2. `apps/api/migrations/0003_tenant-isolation.js` — how isolation is enforced
3. `apps/api/src/core/database/database.service.ts` — the two planes
4. Any `tenant/*/`*.module.ts` — one feature end to end
5. `apps/tenant-web/src/lib/api.ts` — the client contract
