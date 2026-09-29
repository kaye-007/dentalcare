# DentalCare — the security program (pre-production hardening)

Date: 2026-09-28 · Branch `preserve/pre-production-sept-9-18`, commits `717fbba`…`bff3c9b`, then the CI fix `dc24c42` and the decisions of §4 · Follows [PRE_PRODUCTION_BASELINE.md](./PRE_PRODUCTION_BASELINE.md) and [CLAUDE_AUDIT.md](./CLAUDE_AUDIT.md) · The CRM backlog waits: [CRM_BACKLOG.md](./CRM_BACKLOG.md)

**The goal.** Safe → verified → deployable, not "all tests pass".

**The rule.** Every change was tested against a failing case first where one could be written. Every change was verified on a real PostgreSQL, and committed on its own. The developer's own database and API were never touched: all runs used throwaway servers (:55432, then :55442), and one brand-new server for the restore.

**Accepted and pushed.** The owner accepted the hardening pass on 2026-09-28. The 26 commits were pushed that day (`a3ea2fa..f6a6885`) after a final check of every file version they contain. The check covered all 515 blob versions, not only the final tree, and found:

- no `.env` file, only the two `.example` templates, which hold placeholders;
- no secret: the repository's scanner and a wider scan found only test fixtures, placeholders and the local and CI defaults;
- no uploads, databases, backups, build output or local scratch files.

The repository is public, so this mattered. The first CI run on GitHub then failed in two jobs, for toolchain reasons rather than code (row 14). The fix `dc24c42` ran green: [run 36514936865](https://github.com/kaye-007/dentalcare/actions/runs/36514936865). Every push since runs the same three jobs.

---

## 1. What changed

| #   | Before                                                                                                                                                                                                                                         | Now                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Three days of work (migrations 0017–0022, lab, WhatsApp Cloud, 9 integration suites) existed only on this disk                                                                                                                                 | Committed in 9 reviewable slices, each checked for secrets and forbidden files before commit                                                                                                                                                                                                  | `717fbba`…`e4c789a`                                                                                                                                                                                                |
| 2   | Prettier disagreed with 216 files; the gate skipped files not yet committed                                                                                                                                                                    | One formatting-only commit, proven: 187/193 files compile byte-identical, 6 differ only by JSX `{" "}`, and the configs parse equal. `git blame` skips it. The gate checks the whole repository. `.gitattributes` keeps a Windows checkout LF. CI runs on `preserve/**`                       | `f981e77`, `c7bd8d9`, `14fec18`                                                                                                                                                                                    |
| 3   | `npm run test:integration` with nothing exported wrote into the developer's own database                                                                                                                                                       | It refuses unless `TEST_DATABASE_URL` names a database of its own (or CI, or a name that says test)                                                                                                                                                                                           | `cdc9916`: 19 unit tests; a live refusal before any query                                                                                                                                                          |
| 4   | "Today" was the database server's date (UTC): an invoice at 00:30 in Tirana was dated yesterday, while its fiscal registration was not                                                                                                         | `clinic_today()` / `clinic_zone()` (0023). Seven column defaults, 15 queries, Financials, the activity and WhatsApp filters, estimate dates and 12 places in the app all use the clinic's clock                                                                                               | `ea1d093`, `fb40120`: `clinic-day.itest` (failed 10/11 before); suite green with the process clock on UTC, UTC+14 and Tirana                                                                                       |
| 5   | A double click could issue a second invoice, record spending twice or adjust a balance twice                                                                                                                                                   | `@Idempotent` on seven money and fiscal routes. The key is stored under a unique index on invoices, expenses and ledger adjustments (0024). The app sends a key per action                                                                                                                    | `6e6393c`, `abf004d`: `money-idempotency.itest` (failed 8/9 before)                                                                                                                                                |
| 6   | Password guessing was limited only per process (useless on Workers); no lockout                                                                                                                                                                | Counted in the database (0025): 10 failures per account in 15 minutes lock it for 15, whether or not it exists. 100 failures per address lock that address. Keys are HMACs. Unknown addresses cost the same bcrypt work                                                                       | `62b0680`: `auth-lockout.itest` locks on one API process and finds the lock on another                                                                                                                             |
| 7   | Login CSRF on Google sign-in                                                                                                                                                                                                                   | Only the browser that started a sign-in can finish it (a nonce cookie, checked before Google's code is exchanged)                                                                                                                                                                             | `48a5070`: unit tests of both guards                                                                                                                                                                               |
| 8   | The boot check that `app_user` cannot bypass row security let the app start if the check itself failed                                                                                                                                         | Production refuses to start                                                                                                                                                                                                                                                                   | `602ca6b`: 5 unit tests                                                                                                                                                                                            |
| 9   | `app_user` could INSERT into `tenants`                                                                                                                                                                                                         | Revoked (0025)                                                                                                                                                                                                                                                                                | `62b0680`: `privileges.itest`                                                                                                                                                                                      |
| 10  | With no bucket, patient documents went to the container's disk without a word; `STORAGE_DRIVER=s3` without a bucket did the same                                                                                                               | Production must choose a bucket, `local` with `STORAGE_DIR`, or `off`. `s3` without a bucket is refused everywhere                                                                                                                                                                            | `e4ce0ea`: 7 cases                                                                                                                                                                                                 |
| 11  | No backup tooling; a restore never rehearsed; `migrate:baseline --verify` broken                                                                                                                                                               | `db:backup` and `db:restore`: into an empty database only, then the schema, every row count, the migration and row security are checked. Rehearsed onto a brand-new server. `--verify` fixed                                                                                                  | `76945e5`: [DEPLOYMENT.md § Backups and restore](./DEPLOYMENT.md#backups-and-restore)                                                                                                                              |
| 12  | Nothing looked for a committed secret                                                                                                                                                                                                          | `secrets:check` in CI: keys, tokens, JWTs and credentialed database URLs; tracked `.env` refused; known fixtures allowed with reasons                                                                                                                                                         | `21d047f`: 25 tests; 0 findings in 655 files                                                                                                                                                                       |
| 13  | The SPAs sent no HSTS                                                                                                                                                                                                                          | Both send `max-age=31536000; includeSubDomains`                                                                                                                                                                                                                                               | `bff3c9b`                                                                                                                                                                                                          |
| 14  | The first CI run on GitHub failed. Wrangler 4 refuses Node 20, which CI used. The integration job never built the shared package, so 31 of 39 suites failed to compile, and then Jest never exited and held the runner                         | The dry runs run on Node 22 and the tests stay on 20, the container's version. The integration job builds the shared package. Every job has a time limit                                                                                                                                      | `dc24c42`: reproduced in Linux replicas of both jobs, then fixed there; CI green                                                                                                                                   |
| 15  | The Idempotency-Key was optional, and ten routes that move money took none at all: invoice cancel, fiscal retry, the two drawer approvals and force-close, salary payments, the patient import, and the console's billing run, settle and void | **Required** on all 25 routes that move money (22 in the clinic, 3 in the console), and on the WhatsApp batch send. No key → 428; a malformed key → 400. The console keeps its keys in `platform_idempotency_keys` (0026). The clinic app and the console make a key per action on every call | `idempotency-coverage.spec` fails the build on an unmarked money route (proven by removing one mark); `money-idempotency.itest`: every route answers 428; `platform-billing.itest`: 428, then replay, audited once |
| 16  | A manager's approval PIN was inside the stored request hash (SHA-256) for payouts and floats: four to six digits under a fast hash, undoing the bcrypt it is kept under                                                                        | PINs and passwords are left out of the hash wherever they sit in a body                                                                                                                                                                                                                       | `idempotency.interceptor.spec`                                                                                                                                                                                     |
| 17  | Reception could void payments and expenses, and read every expense                                                                                                                                                                             | Reception takes payments and still reads the chart. Only the administrator voids; expenses are seen by the administrator and the accountant                                                                                                                                                   | `permissions.spec`; `reception-money.itest`: 403 on voids and on the expense list; `cash-drawer.itest` voids as the administrator                                                                                  |

**Reviewed and left as they are:**

- **Twilio receipts:** the only inbound webhook. The signature over the URL and body is checked before anything is read; tested.
- **Demo isolation:** seeding needs `DEMO_ENV=true` and refuses production and remote hosts.
- **Tenant isolation:** row security is forced on all 60 tenant tables, and proven again on the restored copy.

---

## 2. Verification, on the final code

| Check                                      | Result                                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck (4 workspaces), lint             | pass                                                                                                                                    |
| Format, whole repository                   | clean                                                                                                                                   |
| Secrets                                    | none in 660 files                                                                                                                       |
| Unit tests                                 | **870 passed** (57 suites), was 857                                                                                                     |
| Builds (shared, API, clinic app, console)  | pass                                                                                                                                    |
| Cloudflare dry runs (3 Workers)            | pass; API 3,678.7 KiB / 958.5 KiB gzip                                                                                                  |
| Migrations 0001 → 0026 on a fresh database | pass; 0023–0025 were each taken down and up again, and 0026 likewise                                                                    |
| Integration tests, as `app_user`           | **587 passed** (40 suites), was 556, under TZ=UTC, UTC+14 and Tirana                                                                    |
| `migrate:baseline --verify`                | byte-identical when the program ran it; not re-run for 0026, which comes after the baseline and changes neither side of that comparison |
| Restore rehearsal                          | Restored whole; the API served health, a sign-in and 300 patients                                                                       |
| Clean-machine `docker compose up`          | CI: green (the `compose` job)                                                                                                           |
| CI on GitHub                               | green on `dc24c42`; each later push runs the same three jobs                                                                            |

One intermittent local failure was seen and explained. `auth-lockout.itest` expects the lock message to say 14 or 15 minutes. The database stamps the lock with its own clock, and this machine's Docker VM runs about 1 ms ahead of Windows, so a sub-millisecond response reads "16 minutes". It happened in 1 of 7 full runs. CI cannot hit it: there the database container shares the runner's clock. The test was left as it is (§5.4).

---

## 3. Still open: needs staging

Each item below can only be proven on a deployed environment, and none of it is claimed until it is. The checklist to work through is [DEPLOYMENT.md § Staging verification](./DEPLOYMENT.md#staging-verification--required-before-any-of-this-is-believed), then [§ Before first paying customer](./DEPLOYMENT.md#before-first-paying-customer).

1. **Cloudflare staging:**
   - real Hyperdrive IDs, created with caching disabled (`cf:check-caching`);
   - the domain and the secrets;
   - the storage choice;
   - one real request.
2. **The restore rehearsal against the provider and staging.** The local one proves the tooling, not the provider's backups.
3. **Google sign-in on the deployed Worker.** The new cookie needs the clinic hosts and the API host to share the parent domain of `GOOGLE_CALLBACK_URL`'s host.
4. **Money through the Worker.** One payment from the deployed clinic app and one settlement from the deployed console must succeed. This proves the Idempotency-Key survives the SPA's service binding to the API. Nothing local can prove it.
5. **Fiscalization:**
   - the CIS test environment;
   - a corrective invoice;
   - a pending row before a cash declaration is sent: today a crash between the call and the write can declare twice.
6. **Messaging providers:** Twilio, WhatsApp Cloud and Viber with real accounts.
7. **Monitoring:** once the provider is chosen, every alert in [MONITORING.md](./MONITORING.md) fired once on staging and seen to reach its owner.
8. **HSTS preload:** decided on the final domain only (decision 7). Not before.
9. **Runtime:** the Workers path is the one being staged. The container path stays working (CI's `compose` job) until staging decides (decision 4).

## 4. Decisions taken (2026-09-28)

1. **Idempotency-Key: required on every route that moves money. Done.**
   - A request without a key gets **428** (`idempotency_key_required`), and a malformed key gets 400. Both happen before the handler runs, and after the sign-in and permission checks, so a caller who may not do the thing is refused for that first.
   - It covers all 25 routes that move money: 22 in the clinic, and the console's three billing routes (run, settle, void). It also covers the WhatsApp batch send. The console keeps its keys in `platform_idempotency_keys` (0026), which the clinic role cannot read.
   - The clinic app and the console send a key per action. The key is a required argument of every client call that moves money, so a call without one does not compile.
   - `idempotency-coverage.spec` fails the build when a route guarded by a money permission is not marked. It lists the five exempt routes with their reasons: no-sale, starting and cancelling a count, setting one's own PIN, and the import preview.
   - Rows 15 and 16.
2. **Revoked sign-ins: accepted as a residual risk for this release. Not redesigned.**
   - _The risk:_ the access token is stateless. For up to `JWT_ACCESS_TTL` (15 minutes) it keeps working, **with the role it was issued with**, after any of these:
     - signing out;
     - a password change;
     - disabling the account;
     - changing its role.
   - _What still holds:_
     - the refresh token is revoked at once, so no new access token is issued;
     - every request is authorized on the server by `PermissionsGuard` (`route-coverage.spec` checks that every clinic route has one);
     - a token works only at its own clinic;
     - row security applies to every query;
     - suspending or archiving a clinic takes effect on the next request, because the clinic is resolved from the database every time.
   - _The lever, if the window must shrink:_ a shorter `JWT_ACCESS_TTL`. Checking the session on sensitive actions is the redesign that was deferred.
   - Recorded in [SECURITY_AUDIT.md](./SECURITY_AUDIT.md#outstanding).
3. **Receptionist permissions. Done.**
   - Kept: `clinical:read`.
   - Removed: `expenses:read`, `payments:void`, `expenses:void`. `payments:void` and `expenses:void` are now administrator-only (`ADMIN_ONLY`).
   - Reception runs the normal payment workflow. A mistaken payment is voided by the administrator.
   - _Left as the decision left it:_ reception still holds `expenses:write`. The expense form lives on the Expenses page, which needs `expenses:read`, so the app no longer offers reception a way to record an expense. The "Add expense" shortcuts are hidden, and the API would still accept one. Whether reception should record expenses (then it needs a record-only form) or lose `expenses:write` too is open (§5.3).
   - Row 17.
4. **Runtime: no decision yet, by decision.** The deployment stays behind its configuration: Workers (`wrangler.jsonc`) or the container (`RUNTIME=node`, `infra/docker`). Nothing was migrated. The choice follows Cloudflare staging (§3.9).
5. **Error tracking: requirements first. Done.** [MONITORING.md](./MONITORING.md) defines:
   - what must be watched: API health, Worker and API errors, sign-in failures, fiscal failures, message failures, the database, backups;
   - the events the application will emit, and the alert rules;
   - an ownership table with every name still to be filled in;
   - the criteria for choosing a provider.

   No provider was added and nothing was wired in. The provider is chosen before production.

6. **Privacy: a technical checklist, not a policy. Done.** [PRIVACY_RETENTION_CHECKLIST.md](./PRIVACY_RETENTION_CHECKLIST.md) covers:
   - what is stored and where;
   - what is kept or deleted today;
   - what a patient can ask for and what the software can do;
   - where data goes outside the database;
   - the questions only a lawyer can answer.

   **It invents no retention period and claims no compliance.** The legal policy requires an Albanian legal and privacy review (§5.1).

7. **HSTS preload: not enabled.** Both SPAs keep sending `max-age=31536000; includeSubDomains`, without `preload`. Preloading is a domain-level decision that is hard to reverse, so it waits for the final domain (§3.8, and [DEPLOYMENT.md § Before first paying customer](./DEPLOYMENT.md#before-first-paying-customer)).

## 5. Still open: legal and outside parties

1. **An Albanian legal and privacy review:**
   - retention periods;
   - the controller and processor roles, and the agreements between NODE X, the clinics and each sub-processor;
   - the legal basis for each purpose;
   - transfers abroad;
   - registration with the data-protection authority;
   - breach duties.

   The questions are written down in [PRIVACY_RETENTION_CHECKLIST.md § 5](./PRIVACY_RETENTION_CHECKLIST.md#5-for-the-legal-and-privacy-review--questions-the-software-cannot-answer). Until it is done, nothing may be described as compliant.

2. **The monitoring provider, and a named owner for every alert** ([MONITORING.md § 3.8](./MONITORING.md#38-alert-ownership)).
3. **Reception and expenses:** keep `expenses:write` and build a record-only form, or withdraw it (decision 3).
4. **The lockout test's tolerance** (§2): accepting 16 minutes as well would end a local-only flake. It was not changed in this checkpoint.
5. **Accounts and certificates from outside parties:**
   - the tax authority's test certificate and registered codes (fiscalization);
   - Twilio, Meta (WhatsApp Business) and Vonage (Viber) accounts;
   - the Cloudflare account, the domain, and the database provider.

**Next:** the CRM backlog, starting at P1 ([CRM_BACKLOG.md](./CRM_BACKLOG.md)), once the owner confirms this checkpoint.
