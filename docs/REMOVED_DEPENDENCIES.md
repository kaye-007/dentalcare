# Dependency Audit

**No dependency was removed. Every declared package is required.**

This is the honest result of the audit rather than a failure to find
candidates. Four packages appear unused to a naive search and are documented
below so the analysis is not repeated.

## Method

For each declared dependency, searched for direct imports across
`apps/*/src` and `apps/api/scripts`, then investigated every zero-hit result
before concluding anything.

## API — `apps/api/package.json`

| Package | Files | Verdict |
|---|---|---|
| `@nestjs/common` | 40 | KEEP |
| `@nestjs/config` | 13 | KEEP |
| `@nestjs/core` | 2 | KEEP |
| `@nestjs/platform-express` | 1 | KEEP |
| `@nestjs/jwt` | 7 | KEEP |
| `nestjs-pino` | 2 | KEEP |
| `pg` | 12 | KEEP |
| `zod` | 1 | KEEP — env validation |
| `bcryptjs` | 5 | KEEP |
| `class-validator` | 10 | KEEP |
| `class-transformer` | 1 | KEEP — `@Type()` in finance, and required by `ValidationPipe({ transform: true })` |
| `reflect-metadata` | **0** | **KEEP** — see below |
| `rxjs` | **0** | **KEEP** — see below |
| `pino-http` | **0** | **KEEP** — see below |

### The zero-hit packages

**`reflect-metadata`** — a *side-effect* import, which has no `from` clause:

```
apps/api/src/main.ts:1:import 'reflect-metadata';
```

Required by NestJS's decorator metadata. Removing it breaks dependency
injection at runtime, not at compile time — the worst kind of failure.

**`rxjs`** — a declared peer dependency of both `@nestjs/core` and
`@nestjs/common`:

```
@nestjs/core   -> peerDeps: @nestjs/common, ..., reflect-metadata, rxjs
@nestjs/common -> peerDeps: class-transformer, class-validator, reflect-metadata, rxjs
```

Not imported directly by this codebase, but NestJS returns Observables
internally. Must remain declared.

**`pino-http`** — a declared peer dependency of `nestjs-pino`:

```
nestjs-pino -> peerDeps: @nestjs/common, pino, pino-http, rxjs
```

## Added

Both were necessary to close audited security findings, not conveniences.

| Package | Version | Why |
|---|---|---|
| `@nestjs/throttler` | ^6.5.0 | Rate limiting on credential endpoints. Both logins were unthrottled; the platform login gates cross-tenant access. The framework-native choice — no new paradigm. |
| `helmet` | ^8.3.0 | Baseline security headers (HSTS, nosniff, frame options). The de-facto Express standard. |

### Dev dependencies added

| Package | Version | Why |
|---|---|---|
| `jest` | ^29.7.0 | The repository had zero tests. Every fix on this branch changes behaviour in a security-critical path. |
| `ts-jest` | ^29.4.12 | TypeScript support for Jest. |
| `@types/jest` | ^29.5.14 | Types. |

Jest is the NestJS default and pairs with `@nestjs/testing`, already available
transitively — chosen to match the ecosystem rather than introduce a new one.

## Frontends

`tenant-web` and `admin-web` declare four runtime dependencies each. All are
used; nothing was added or removed.

| Package | tenant-web | admin-web | Note |
|---|---|---|---|
| `react` | 18 files | 5 files | KEEP |
| `react-dom` | **0** | **0** | **KEEP** — imported via the subpath `react-dom/client` in `main.tsx`, which a naive `from 'react-dom'` search misses |
| `react-router-dom` | 11 files | 6 files | KEEP |
| `lucide-react` | 14 files | 3 files | KEEP |

## Note on `npm audit`

`npm install` reports advisories in the transitive tree. None were addressed
here: `npm audit fix --force` would move major versions of framework packages,
which is exactly the kind of untested change this mission forbids. Dependency
upgrades belong in their own change with their own verification, and gating
them needs CI that does not exist yet.
