# Pre-production baseline

**This is not a production release.** It records the state that was preserved on
2026-09-26 so that the Sept 9–18 DentalCare work cannot be lost. No application
code was changed to produce it.

|                         |                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| **Repository**          | `https://github.com/kaye-007/dentalcare`                                                               |
| **Branch**              | `preserve/pre-production-sept-9-18` (pushed, tracking `origin`)                                        |
| **Commit**              | `a6eb2885333480e2412207e674695933a49d0454`: `chore: preserve pre-production DentalCare implementation` |
| **Parent**              | `2fb91f5` (`production-hardening`, left unchanged locally)                                             |
| **Tag**                 | `pre-production-baseline-2026-09` (annotated, on `a6eb288`, pushed)                                    |
| **Remote**              | `origin`. `main` untouched at `0e88c3d`; nothing force-pushed, no history rewritten                    |
| **Working tree status** | clean after the commit                                                                                 |
| **Modified files**      | 166 modified + 4 deleted (+28,453 / −7,182 lines)                                                      |
| **Untracked files**     | 214 (≈43,000 lines of text + 4 binary test fixtures), all now committed                                |
| **Commit size**         | 385 files, +72,024 / −7,182                                                                            |
| **Migrations**          | 16: `0001_baseline` … `0016_platform_billing`                                                          |
| **Integration suites**  | 27 present (14 were previously untracked)                                                              |
| **Unit tests**          | PASS: 43 suites, 695 tests                                                                             |
| **Typecheck**           | PASS                                                                                                   |
| **Build**               | PASS (shared, api, tenant-web, admin-web)                                                              |
| **Lint**                | PASS                                                                                                   |
| **Cloudflare dry-run**  | PASS (all three Workers)                                                                               |
| **Format**              | FAIL: 80 files                                                                                         |
| **Doctor**              | ENVIRONMENT BLOCKED: PostgreSQL unavailable                                                            |
| **Integration tests**   | ENVIRONMENT BLOCKED: not run, PostgreSQL unavailable                                                   |

The test and build results are from the audit run on 2026-09-26 against this
exact working tree (see [`CLAUDE_AUDIT.md`](CLAUDE_AUDIT.md)). Nothing changed
in the code between that run and the commit.

## Verified results

**PASS**

- typecheck
- unit tests: 43 test suites, 695 unit tests
- builds
- lint
- Cloudflare dry-run

**FAIL**

- format check: 80 files

**ENVIRONMENT BLOCKED**

- doctor: PostgreSQL unavailable
- integration tests: PostgreSQL unavailable

## Known failures

1. **Format check:** 80 files currently fail Prettier. CI will be red on this
   until they are formatted in a separate, logic-free commit.
2. **Doctor:** PostgreSQL unavailable on the machine that made this baseline.
3. **Integration tests:** not yet run, because PostgreSQL was unavailable.
4. **Tenant isolation:** the code review suggests it is correct (RLS enabled
   and forced on every tenant table, host-bound tokens, privileged plane
   confined to the platform). **It is NOT verified.** Database-level
   verification by the integration suites is still required.

## How this baseline was made

1. `preserve/pre-production-sept-9-18` was created from exactly `2fb91f5`,
   carrying the working tree unchanged. Nothing was reset, stashed or cleaned.
2. Every file to be committed (552 paths) was checked for secrets; none were
   found. Details, without values, are in
   [`PRE_PUSH_INVENTORY.md`](PRE_PUSH_INVENTORY.md#secrets-check). `.env`
   is git-ignored and absent from all history.
3. **A stale `.git/index.lock`** (0 bytes, dated 2026-09-09 10:02, no git
   process running) blocked staging. It was renamed, not deleted, to
   `.git/index.lock.stale-2026-09-09`. It most likely explains why nothing
   could be committed after 2026-09-09. It can be deleted at any time.
4. Committed, pushed as a new branch (a fast-forward from `origin/main`'s
   history), tagged, and the tag pushed.
5. This file was added in a follow-up commit on the same branch, because it
   names the commit and tag above.

## What was on the remote before this

Only `main` at `0e88c3d` ("Add project files"). The 38 local commits on
`production-hardening` (Aug 6 → Sep 8) had never been pushed either. They are
now on the remote as ancestors of `a6eb288`.

## Not done here, deliberately

No formatting, no code fixes, no migrations run, no production configuration
touched, `main` not updated, `production-hardening` not moved, M1 not started.
