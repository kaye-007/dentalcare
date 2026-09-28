# DentalCare — Execution Plan

**Date:** 2026-09-26 · Companion to [`CLAUDE_AUDIT.md`](CLAUDE_AUDIT.md) · Nothing here has been started.

Every phase follows the same loop: inspect → explain → smallest safe change →
tests → typecheck → build → relevant integration/smoke → review the diff →
report what changed and what risk remains. A phase is not done because it
compiles; it is done when its exit criteria hold **on a real database**.

Decisions marked **(you)** are product or legal calls. The phase stops at them
rather than guessing.

---

## Order and why

```
0 Secure the work ──► 1 Prove it on a DB ──► 2 Money gaps ──► 3 Auth hardening ──► 4 Least privilege
                                                                                     │
         8 Docs truth pass ◄── 7 Daily-workflow UX ◄── 6 Deploy + staging ◄── 5 Fiscalization
```

- **0 before everything:** ~70k lines exist only on one disk. No other work
  should be layered on top of an uncommitted tree.
- **1 before any change:** establishes the green baseline every later phase is
  measured against. Today the integration suite has not been seen to pass on
  this tree.
- **2 → 4 are small, contained, and security/money-critical;** they do not
  depend on external parties.
- **5 depends on external verification** (official Albanian sources, the CIS
  test environment, a test certificate). Start the verification requests early,
  in parallel with 2–4; do the code after.
- **6 needs 2–5 settled** so staging tests the real system.
- **7 is last among the code phases** because it is the most taste-driven and
  benefits from a staging environment people can click through.
- **8 closes out;** small doc fixes also land inside each phase as they happen.

---

## Phase 0 — Secure the uncommitted work · S

**Goal:** the working tree is in git, on the remote, and reviewable.

1. **(you)** Confirm no persistent database (staging, the old Docker volume,
   anyone's laptop that matters) ran the _committed_ `0001_baseline.js` — the
   working copy edits it.
2. Commit in reviewable slices, not one blob — for example: migrations
   0002–0016 + baseline edit; core (mfa, sessions, idempotency, money, pdf,
   request-context, entitlements); each clinic module; platform modules;
   shared package; SPAs; integration tests; scripts; docs.
3. Push to a branch (not `main`). Open a PR so CI runs. Do **not** force-push
   or rewrite `main`.
4. Archive `Downloads/dentalcare-m16.zip` somewhere deliberate; stop treating it
   as a live copy.

**Exit:** `git status` clean; branch on `origin`; CI has run (it will fail on
format — that is Phase 1).

## Phase 1 — Prove the tree on a real database · S–M

1. Start Postgres (`npm run dev:up` or `dev:setup`); fix `.env` tenant
   resolution so `npm run doctor` is green.
2. `migrate:reset` → `migrate:up` on a **fresh** database; then run
   `npm run test:integration` (27 suites) and `npm run smoke`.
3. Run Prettier on the 80 flagged files as its own commit (no logic changes).
4. Record the real test counts.

**Exit:** doctor green; all unit + integration suites pass; CI green on the PR.
Any failure found here is fixed before Phase 2, in its own small commit.

## Phase 2 — Close the money gaps · M

1. Add `@Idempotent()` + SPA keys to: create invoice, create expense, void
   expense, ledger adjustment, invoice-from-plan, fiscal cash deposit. Where a
   double run would duplicate money, add the second guard in the same
   transaction (unique key column), as payments already do.
2. **(you)** Decide whether the `Idempotency-Key` header becomes _required_ on
   money routes (recommended: yes for the clinic SPA, 428 when missing).
3. **(you)** Decide whether voiding a payment or expense needs manager approval
   (the drawer's approval/PIN mechanism already exists and could be reused).
4. Integration tests: replay returns the first response; concurrent repeat
   gets 409; the ledger reconciles (payments − voids = ledger = invoice status).

**Exit:** no money-moving route without duplicate protection; reconciliation
test passes.

## Phase 3 — Authentication hardening · M

1. Durable brute-force protection that works on both runtimes: per-account
   failed-password counter + temporary lock in Postgres (the MFA lockout is the
   model), plus a DB- or Cloudflare-backed rate limiter instead of in-memory.
2. Bind OAuth `state` to the browser (short-lived `HttpOnly; SameSite=Lax`
   cookie holding the nonce, checked at the callback) to close login CSRF.
3. Make the boot-time RLS-bypass check fail **closed** in production when it
   cannot run.
4. Migration revoking `INSERT` / column `UPDATE` on `tenants` from `app_user`
   if no clinic-plane code needs them (verify first).
5. **(you)** Decide whether 15 min access-token revocation lag is acceptable
   or whether sensitive actions (disable user, role change) should also check
   the session row.

**Exit:** throttle, lockout, and OAuth-binding integration tests pass on both
runtimes' code paths; `privileges.itest.ts` asserts the revoked grant.

## Phase 4 — Least-privilege decisions · S

**(you)** For the receptionist role: keep or remove `clinical:read`,
`expenses:read`, `payments:void`, `expenses:void`. Then change only
`packages/shared/src/permissions.ts` + its spec, and let `route-coverage.spec`
and the SPA's permission-driven navigation follow.

**Exit:** permission spec encodes the decision; an integration test shows a
receptionist is refused on each removed capability.

## Phase 5 — Fiscalization · L

1. **Verify before coding.** From current official sources (tatime.gov.al,
   the published CIS service description, the VAT law as amended): SOAP actions
   and schema version, exemption codes for medical services, rounding rules,
   corrective-invoice rules, cash-deposit rules, the 48 h window. Record each
   rule with its source and date in `docs/`.
2. Run the module against the **CIS test environment** with a test certificate:
   register invoice, cash deposit, subsequent delivery, a refusal.
3. Implement the **corrective invoice** the UI and triggers already promise —
   linked to the original, fiscalized, with ledger entries that reverse through
   the ledger, never an edit.
4. Certificate-expiry warning to the clinic admin before `notAfter`.

**Exit:** a documented, source-cited rule set; a recorded successful exchange
with CIS test; a corrective invoice round-trips; ledger + fiscal reconcile.

## Phase 6 — Deployment decision and staging · M

1. **(you)** Choose the production runtime: Workers or the single-replica
   container. Recommendation: Workers, since the cron, Hyperdrive and
   per-request pool are already built and tested, and the container's
   one-replica limit is a scaling ceiling.
2. Real domain, real Hyperdrive IDs (both with caching **off**; the
   `cf:check-caching` script exists), secrets set.
3. Execute every box in `DEPLOYMENT.md` § Staging verification, including two
   clinics isolated on staging, and **one backup actually restored** to a new
   database.

**Exit:** the staging checklist is ticked with dates and evidence.

## Phase 7 — Daily-workflow UX · M–L

1. **(you)** Language: English-only (current) or Albanian staff UI. If
   Albanian, restore a complete Shqip table in `strings.ts` — the old
   dictionary was partial — and cover the ~inline strings it never reached.
   This is the largest item in the phase.
2. Walk each role's daily path on staging with a stopwatch (receptionist:
   find → book → check in → take payment → receipt → close drawer; doctor:
   today → patient → history → chart → note → treatment → plan → next visit;
   owner: today's business → revenue → balances → expenses). Fix only the
   clicks and dead ends found.
3. Doctor-specific "my day" filter on the dashboard, if the walk-through shows
   the need.

**Exit:** each role's path works without training and without dead ends, and a
real receptionist or dentist has tried it.

## Phase 8 — Documentation truth pass · S

Update README test counts; remove the obsolete m16 divergence warnings from
`ARCHITECTURE.md`, `SECURITY_AUDIT.md`, `RELEASE_CHECKLIST.md` (replace with
one line pointing at `CLAUDE_AUDIT.md` §18); bring `CHANGELOG.md` current.

---

## Explicitly out of scope

Not to be built during this plan: waitlist; PWA/mobile shell; an in-console
database restore button; a patient portal; an ORM; a client state library; a
repository-wide refactor of `tx()`, formatters or `api.ts` (touch them only
inside a phase that already edits those files); merging anything from m16.
