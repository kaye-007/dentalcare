# Removed Files

Every removal, with the evidence that justified it. Nothing was removed on
suspicion.

## Removed

### `dentalcare/` — orphaned submodule gitlink

**What.** A tracked entry at the repository root, plus an on-disk directory
containing a single `.gitattributes`.

**Evidence.**

```
$ git ls-files -s dentalcare
160000 9d9ef0158b5c92a990118bfe4c491a0222d844c4 0	dentalcare
```

- Mode `160000` is a **gitlink** — a submodule reference, not a directory.
- `git cat-file -t 9d9ef01` → `fatal: could not get object info`. The target
  commit does not exist in this repository.
- No `.gitmodules` exists, so nothing configures where it would come from.
- No source file references the path.

**Why it mattered.** `git clone --recurse-submodules` would fail or produce a
confusing empty directory. It was almost certainly a nested git repo committed
by accident.

**Reversible?** Yes — `git revert`. Nothing depended on it.

### `redis` service in `docker-compose.yml`

**Evidence.**

```
$ grep -rn "redis\|REDIS" apps/api/src apps/*/src
apps/api/src/core/config/env.validation.ts:26:  REDIS_URL: z.string()...   (declaration only)
apps/api/src/tenant/reminders/reminders.module.ts:251: * BullMQ ...        (comment only)
```

- No Redis client library in any `package.json`.
- No import, no connection, anywhere in either plane.
- The only mentions were the env declaration itself and a comment describing a
  *possible future* BullMQ migration.

**Why now.** The mission keeps the existing architecture, so the reminder
scheduler stays in-process and the rate limiter uses in-memory storage.
Nothing is queued to consume Redis. It was a container consuming memory on
every developer's machine for no functional reason.

**Reversible?** Trivially — re-add the service block and `REDIS_URL`. If a
queue or a distributed scheduler lock lands later, Redis becomes required
infrastructure and should come back. See `MASTER_REMEDIATION_PLAN.md` H6.

## Removed configuration

| Item | File | Evidence |
|---|---|---|
| `REDIS_URL` | `env.validation.ts`, `.env.example`, `docker-compose.yml` | As above — declared, never read. |
| `packages/*` workspace glob | `package.json` | No `packages/` directory exists. `npm` silently ignored it; it misrepresented the repo shape. |
| `'cancelled'` / `'trial'` status branches | `tenant.middleware.ts`, `auth.service.ts`, `users.service.ts` | Unreachable since migration `0004` redefined `tenants_status_check`. Replaced by an allowlist, which also closes the `archived` hole. |

## Considered and **kept**

Recorded so the same analysis is not redone.

| Candidate | Verdict | Reason |
|---|---|---|
| `POST /api/auth/refresh` | **Kept** | Looked dead — no client called it. It is now the backbone of the silent-refresh fix. Deleting it would have been the wrong call. |
| `tokenStore.refresh` getter | **Kept** | Same: unread before this branch, now used by `request()`. |
| Duplicated `lib/api.ts` between SPAs | **Kept** | Genuinely similar, but they differ correctly — tenant-web sends `X-Tenant-Subdomain` and holds a refresh token; admin-web does neither. Extracting to a shared package costs more than it saves at this size. |
| `RLS()` helper duplicated in migrations `0007` and `0009` | **Kept** | Applied migrations are immutable history. Editing them would desynchronise every existing database. |
| `private tx()` in 7 services | **Kept for now** | Real duplication, mechanical to extract into a base class. Deferred because it touches every feature service and there is no service-level test coverage yet. Tracked in `MASTER_REMEDIATION_PLAN.md` Phase 7. |
| `CurrentUser` / `CurrentAdmin` decorators | **Kept** | Deliberately parallel, different payload types. Not duplication. |
| Topbar search input (inert) | **Kept** | Non-functional, but removing visible UI is a product decision, not a cleanup one. Documented instead. |
| All 13 tenant-web pages, all components | **Kept** | Import analysis found every one reachable from `App.tsx`. Zero dead files. |

## Note on scope

This repository is a snapshot that diverges from another copy of the project
(32 migrations vs. 11 here). "Unused" throughout this document means unused
*in this snapshot*. See [`CLEANUP_REPORT.md`](CLEANUP_REPORT.md).
