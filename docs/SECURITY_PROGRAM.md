# DentalCare — the security program (pre-production hardening)

Date: 2026-09-28 · Branch `preserve/pre-production-sept-9-18`, commits `717fbba`…`bff3c9b` · Follows [PRE_PRODUCTION_BASELINE.md](./PRE_PRODUCTION_BASELINE.md) and [CLAUDE_AUDIT.md](./CLAUDE_AUDIT.md) · The CRM backlog waits: [CRM_BACKLOG.md](./CRM_BACKLOG.md)

**The goal.** Safe → verified → deployable, not "all tests pass".

**The rule.** Every change was tested against a failing case first where one could be written. Every change was verified on a real PostgreSQL, and committed on its own. The developer's own database and API were never touched: all runs used a throwaway server on :55432, and one brand-new server for the restore.

**Not pushed.** The commits are local. The push was refused by the session's safety check, so the work is still only on this disk until someone runs:

```
git push origin preserve/pre-production-sept-9-18
```

---

## 1. What changed

| #   | Before                                                                                                                                 | Now                                                                                                                                                                                                                                                                     | Evidence                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Three days of work (migrations 0017–0022, lab, WhatsApp Cloud, 9 integration suites) existed only on this disk                         | Committed in 9 reviewable slices, each checked for secrets and forbidden files before commit                                                                                                                                                                            | `717fbba`…`e4c789a`                                                                                                          |
| 2   | Prettier disagreed with 216 files; the gate skipped files not yet committed                                                            | One formatting-only commit, proven: 187/193 files compile byte-identical, 6 differ only by JSX `{" "}`, and the configs parse equal. `git blame` skips it. The gate checks the whole repository. `.gitattributes` keeps a Windows checkout LF. CI runs on `preserve/**` | `f981e77`, `c7bd8d9`, `14fec18`                                                                                              |
| 3   | `npm run test:integration` with nothing exported wrote into the developer's own database                                               | It refuses unless `TEST_DATABASE_URL` names a database of its own (or CI, or a name that says test)                                                                                                                                                                     | `cdc9916`: 19 unit tests; a live refusal before any query                                                                    |
| 4   | "Today" was the database server's date (UTC): an invoice at 00:30 in Tirana was dated yesterday, while its fiscal registration was not | `clinic_today()` / `clinic_zone()` (0023). Seven column defaults, 15 queries, Financials, the activity and WhatsApp filters, estimate dates and 12 places in the app all use the clinic's clock                                                                         | `ea1d093`, `fb40120`: `clinic-day.itest` (failed 10/11 before); suite green with the process clock on UTC, UTC+14 and Tirana |
| 5   | A double click could issue a second invoice, record spending twice or adjust a balance twice                                           | `@Idempotent` on seven money and fiscal routes. The key is stored under a unique index on invoices, expenses and ledger adjustments (0024). The app sends a key per action                                                                                              | `6e6393c`, `abf004d`: `money-idempotency.itest` (failed 8/9 before)                                                          |
| 6   | Password guessing was limited only per process (useless on Workers); no lockout                                                        | Counted in the database (0025): 10 failures per account in 15 minutes lock it for 15, whether or not it exists. 100 failures per address lock that address. Keys are HMACs. Unknown addresses cost the same bcrypt work                                                 | `62b0680`: `auth-lockout.itest` locks on one API process and finds the lock on another                                       |
| 7   | Login CSRF on Google sign-in                                                                                                           | Only the browser that started a sign-in can finish it (a nonce cookie, checked before Google's code is exchanged)                                                                                                                                                       | `48a5070`: unit tests of both guards                                                                                         |
| 8   | The boot check that `app_user` cannot bypass row security let the app start if the check itself failed                                 | Production refuses to start                                                                                                                                                                                                                                             | `602ca6b`: 5 unit tests                                                                                                      |
| 9   | `app_user` could INSERT into `tenants`                                                                                                 | Revoked (0025)                                                                                                                                                                                                                                                          | `62b0680`: `privileges.itest`                                                                                                |
| 10  | With no bucket, patient documents went to the container's disk without a word; `STORAGE_DRIVER=s3` without a bucket did the same       | Production must choose a bucket, `local` with `STORAGE_DIR`, or `off`. `s3` without a bucket is refused everywhere                                                                                                                                                      | `e4ce0ea`: 7 cases                                                                                                           |
| 11  | No backup tooling; a restore never rehearsed; `migrate:baseline --verify` broken                                                       | `db:backup` and `db:restore`: into an empty database only, then the schema, every row count, the migration and row security are checked. Rehearsed onto a brand-new server. `--verify` fixed                                                                            | `76945e5`: [DEPLOYMENT.md § Backups and restore](./DEPLOYMENT.md#backups-and-restore)                                        |
| 12  | Nothing looked for a committed secret                                                                                                  | `secrets:check` in CI: keys, tokens, JWTs and credentialed database URLs; tracked `.env` refused; known fixtures allowed with reasons                                                                                                                                   | `21d047f`: 25 tests; 0 findings in 655 files                                                                                 |
| 13  | The SPAs sent no HSTS                                                                                                                  | Both send `max-age=31536000; includeSubDomains`                                                                                                                                                                                                                         | `bff3c9b`                                                                                                                    |

**Reviewed and left as they are:**

- **Twilio receipts:** the only inbound webhook. The signature over the URL and body is checked before anything is read; tested.
- **Demo isolation:** seeding needs `DEMO_ENV=true` and refuses production and remote hosts.
- **Tenant isolation:** row security is forced on all 60 tenant tables, and proven again on the restored copy.

---

## 2. Verification, on the final code

| Check                                      | Result                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| Typecheck (4 workspaces), lint             | pass                                                                          |
| Format, whole repository                   | clean                                                                         |
| Secrets                                    | none in 655 files                                                             |
| Unit tests                                 | **857 passed** (55 suites), was 759                                           |
| Builds (shared, API, clinic app, console)  | pass                                                                          |
| Cloudflare dry runs (3 Workers)            | pass; API 3,677.0 KiB / 957.7 KiB gzip                                        |
| Migrations 0001 → 0025 on a fresh database | pass; 0023, 0024, 0025 each taken down and up again                           |
| Integration tests, as `app_user`           | **556 passed** (39 suites), was 525, under TZ=UTC, UTC+14 and Tirana          |
| `migrate:baseline --verify`                | byte-identical                                                                |
| Restore rehearsal                          | Restored whole; the API served health, a sign-in and 300 patients             |
| Clean-machine `docker compose up`          | not run locally (it would collide with the developer's own stack); CI runs it |

---

## 3. Still open: needs staging, real accounts or outside parties

1. **Push the branch.** Then CI runs for the first time, including `docker compose up` from nothing.
2. **Cloudflare staging:**
   - real Hyperdrive IDs, created with caching disabled (`cf:check-caching`);
   - the domain and the secrets;
   - the storage choice;
   - every box in [DEPLOYMENT.md § Staging verification](./DEPLOYMENT.md#staging-verification--required-before-any-of-this-is-believed).
3. **The restore rehearsal against the provider and staging.** The local one proves the tooling, not the provider's backups.
4. **Google sign-in on the deployed Worker.** The new cookie needs the clinic hosts and the API host to share the parent domain of `GOOGLE_CALLBACK_URL`'s host.
5. **Fiscalization:**
   - the CIS test environment;
   - a corrective invoice;
   - a pending row before a cash declaration is sent: today a crash between the call and the write can declare twice.
6. **Messaging providers:** Twilio, WhatsApp Cloud and Viber with real accounts.
7. **Monitoring:** uptime on `/api/health`, error tracking and alerting.

## 4. Decisions only you can make

1. **Require the Idempotency-Key** on money routes (428 when missing)? Recommended for the clinic app; today it is optional, as before.
2. **Revoked sign-ins** keep working for up to 15 minutes (the access token's life). Accept it, shorten it, or check the session on sensitive actions?
3. **Receptionist permissions:** `clinical:read`, `expenses:read`, `payments:void`, `expenses:void`. Keep or remove each?
4. **Runtime:** Workers or the container.
5. **Error tracking:** which provider, and who is alerted?
6. **Privacy:** a retention and data-protection policy for patient records (Albanian law). Patients are archived, never deleted, today.
7. **HSTS preload** for the domain: one-way, the domain owner's call.

When you call the security pass complete, the CRM backlog starts at P1.
