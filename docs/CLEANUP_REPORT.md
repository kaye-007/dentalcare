# Cleanup Report

What was changed, what was deliberately left alone, and why.

---

## Headline

**This codebase was already clean.** The cleanup mission anticipated dead
files, abandoned experiments, duplicate configs, and unused dependencies. An
import-graph analysis found none of those.

- **Zero dead files.** Every one of the 13 tenant-web pages is routed from
  `App.tsx`; every component has a live importer; every module in
  `app.module.ts` is registered and reachable.
- **Zero unused dependencies.** All four zero-hit packages turned out to be
  required. See [`REMOVED_DEPENDENCIES.md`](REMOVED_DEPENDENCIES.md).
- **Zero `TODO`/`FIXME`/`HACK` markers**, no commented-out blocks, no `.bak`
  or `.old` files, no abandoned implementations.
- `node_modules/`, `dist/`, `coverage/` were already correctly gitignored and
  untracked.

The repository did not get "significantly smaller" because there was almost
nothing to remove. Manufacturing deletions to hit that goal would have
violated the mission's own rule that every deletion needs evidence.

**The real defects were not clutter — they were correctness and security
bugs**, several invisible to static reading. Those are the substance of this
branch.

## What was removed

Three items, each with proof in [`REMOVED_FILES.md`](REMOVED_FILES.md):

| Item | Evidence |
|---|---|
| `dentalcare/` orphaned submodule gitlink | Mode `160000` → commit `9d9ef01`, which does not exist in this repo; no `.gitmodules` |
| Redis (compose service + `REDIS_URL`) | No client library, zero imports; only a comment about a hypothetical future queue |
| `packages/*` workspace glob | No such directory |

## What was fixed

Detail in [`SECURITY_AUDIT.md`](SECURITY_AUDIT.md) and
[`CHANGELOG.md`](CHANGELOG.md).

**2 Critical** — config could silently disable all tenant isolation; the seed
script could reset production credentials.

**5 High** — archived tenants kept access; the tenant header failed open; no
password management existed anywhere; no rate limiting on either login;
refresh tokens were issued but never used.

**Two latent concurrency bugs** that static reading does not reveal: both the
invoice-numbering retry and the reminder scan tried to recover from a unique
violation by continuing inside an already-aborted transaction, which
PostgreSQL rejects with `25P02`. Both retries were dead code that converted
recoverable conflicts into failures. The reminder one only manifests with more
than one API instance — precisely what horizontal scaling introduces.

**One architectural fix** — reminder delivery moved out of the database
transaction. Harmless today with the log channel; a correctness bug the moment
a real SMS provider is plugged into the `ReminderChannel` interface, which is
the interface's entire purpose.

## What was deliberately not done

Judgement calls, recorded so they are not mistaken for oversights.

**`private tx()` duplicated across 7 services.** Real duplication, mechanically
extractable into a base class. Left in place: it touches every feature service
and there is no service-level test coverage yet. My own remediation plan
sequenced this as Phase 7 precisely because refactoring shared plumbing before
tests exist trades real regression risk for stylistic gain. Tracked in
[`MASTER_REMEDIATION_PLAN.md`](MASTER_REMEDIATION_PLAN.md).

**Controllers and DTOs declared inside `*.module.ts`.** Unconventional for
NestJS, but applied consistently and readable. Splitting ~10 modules is a
large diff with no behavioural benefit and real merge cost. Documented in
[`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md) instead.

**Duplicated `lib/api.ts` between the two SPAs.** They differ correctly —
tenant-web sends the tenant header and holds a refresh token, admin-web does
neither. Extracting a shared package costs more than it saves at this size.

**`npm audit` advisories.** `--force` would move major framework versions,
which is exactly the untested change this mission forbids. Belongs in its own
change, gated by CI that does not exist yet.

**Unused CSS.** Not attempted. Proving a selector unused across dynamic
`className` construction is not reliable by grep, and the mission says do not
guess. The single stylesheet is ~500 lines and coherent.

**The inert topbar search input.** Removing visible UI is a product decision,
not a cleanup one.

## Verification

Run after every logical change; all green at each commit.

```
npm test -w @dentalcare/api     47 passed, 4 suites
npm run api:build               nest build — clean
npm run web:build               1594 modules, 277.61 kB (79.24 kB gzip)
npm run admin:build             1580 modules, 181.21 kB (57.86 kB gzip)
docker compose config           valid; fails loudly without JWT_SECRET
```

Runtime verification against local Postgres: API boots, all routes map
including the three new password/refresh endpoints, the RLS role assertion
runs and passes for `app_user`, helmet headers are present on responses, and
130 requests to `/api/health` produced 118×200 followed by 429s.

## Commits

Ten focused commits, each independently revertible:

```
f8785ba  fix(security): require APP_DATABASE_URL in production and verify RLS role
66dfcb0  fix(security): refuse to seed production databases
86e04b4  fix(security): deny archived tenants and fail closed on the tenant header
b9490ff  fix(finance): make the invoice-number retry actually work
5425135  fix(reminders): deliver outside the transaction and fix conflict handling
0d50071  feat(auth): add password change and owner-initiated staff reset
6d80421  fix(auth): complete the refresh token lifecycle
cfbab72  feat(security): add rate limiting, security headers, and configurable CORS
3af8e20  test: add regression tests for the security fixes
cd80990  chore(cleanup): remove orphaned submodule, unused Redis, and fix compose
7ca0aa4  build(deploy): add Vercel, Render, and production env templates
```

One slip worth recording: `cd80990` also swept in `ARCHITECTURE.md` and
`MASTER_REMEDIATION_PLAN.md` via `git add -A`. Harmless, but it mixes docs
into a chore commit.

---

## Important: this snapshot diverges from another copy of the project

Discovered while checking whether the API container was healthy, and it
materially limits what this report can claim.

The running Docker container was built from
`C:\Users\Klaid\Downloads\dentalcare-m16\dentalcare`, which is substantially
ahead of this repository:

| | This repository | `dentalcare-m16` |
|---|---|---|
| Migrations | 11 | **32** (matches the live database) |
| API source files | 44 | **73** |
| tenant-web files | 23 | **61** |
| Git history | 1 commit, *"Add project files"* | **12** commits of feature work |
| CI / deploy config | none (before this branch) | `.github/`, `deploy/`, `docker-compose.prod.yml` |

The two have **unrelated git histories** — neither contains the other's
commits. The live database has all 32 migrations applied. The running API
serves routes absent from this snapshot entirely (MFA, platform backups,
tenant commercial terms).

Several fixes on this branch already exist there, some implemented almost
identically — `APP_DATABASE_URL` required in production via `superRefine`,
session revocation, rate limits, and a `buildUpdateSet()` extraction.

**Consequences for this report.** "Unused" means unused *in this snapshot*. If
the 21 missing migrations and ~65 missing source files are meant to return,
some of what is documented here as absent is merely absent *here*.

**Consequence for release.** This repository holds the GitHub remote
(`kaye-007/dentalcare`); `dentalcare-m16` has none. Pushing this branch to
that remote would publish a snapshot missing two months of work as the
canonical repository. Reconcile the two before pushing.

The user was informed of this and chose to proceed in this copy. That decision
is respected, and recorded here so it is not mistaken for an oversight.
