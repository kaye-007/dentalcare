# Monitoring — requirements and interface

Date: 2026-09-28 · Owner's decision 5 in [SECURITY_PROGRAM.md](./SECURITY_PROGRAM.md#4-decisions-taken-2026-09-28)

**Status: requirements only.** No monitoring provider has been chosen, and nothing in this document is wired into the code yet. The decision was to define what must be watched first, and to choose the provider before production deployment. Nothing here claims the product is monitored today.

Each section below says what the code already records, what is missing, and what must alert. The alert rules are starting points, and they will need tuning against real traffic.

---

## 1. Principles

- **Provider-neutral.** The application emits events; a provider collects them. Every event in §2 is one structured log line with a stable `event` name. On Workers it goes through `console`, which is what Workers Logs reads. On the container it goes through pino as JSON. Any provider that ingests logs can implement this contract without a change to the application: Workers Logs with Logpush, a log drain, or an SDK adapter.
- **No patient data in any event.** Events identify things by id: the clinic's tenant id, the request id, a record id. They never carry names, phone numbers, email addresses, clinical text or per-patient amounts. Addresses and accounts appear only as the HMAC keys `auth_throttle` already uses. The application log already keeps this rule (see [DEPLOYMENT.md § Health, logging, observability](./DEPLOYMENT.md#health-logging-observability)), and monitoring must not be the thing that breaks it.
- **Every alert has an owner.** An alert that nobody is named to answer is not an alert (§4).
- **Page only for what someone must act on now.** Everything else becomes a ticket or a digest.

## 2. The interface: events the application emits

Every event carries these common fields:

| Field       | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `event`     | the name below; stable, and the thing alert rules match on     |
| `level`     | `info`, `warn` or `error`                                      |
| `time`      | ISO 8601, UTC                                                  |
| `requestId` | the `x-request-id` of the request, when there is one           |
| `tenantId`  | the clinic's id, or `null` for the console and system jobs     |
| `runtime`   | `workers` or `node`                                            |
| `release`   | the commit the build came from (to be added to the build vars) |

The event catalogue:

| Event                                   | Emitted when                                                                 | Extra fields                                                 | Today                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `api.error`                             | a request ends in an unhandled error (5xx)                                   | `route` (the template, never the URL), `status`, `errorName` | Nest's default handler logs the stack; no route template; no event name |
| `api.health.degraded`                   | `/api/health` answers 503                                                    | `checks`                                                     | the endpoint is truthful (CI proves 503); nothing emits                 |
| `db.pool.error`                         | a pool reports an error                                                      | `pool` (`app` or `admin`)                                    | logged as text by `DatabaseService`                                     |
| `db.rls_check.failed`                   | the boot check of `app_user` cannot be verified                              | —                                                            | production refuses to start; logged                                     |
| `auth.sign_in.failed`                   | a sign-in is refused for the credentials                                     | `scope` (`clinic` or `platform`)                             | counted in `auth_throttle`; not logged                                  |
| `auth.sign_in.locked`                   | an account or an address reaches its limit                                   | `scope`, `kind` (`account` or `address`)                     | the lock is in `auth_throttle`; not logged                              |
| `auth.mfa.locked`                       | a second factor locks after five failures                                    | `scope`                                                      | on the factor row; not logged                                           |
| `fiscal.registration.failed`            | the tax authority (CIS) could not be reached or timed out                    | `fiscalId`, `attempt`                                        | on the `fiscal_invoices` row; the scheduler logs errors                 |
| `fiscal.registration.refused`           | CIS refused an invoice (a person must correct it)                            | `fiscalId`, `faultCode`                                      | on the row; logged as a warning                                         |
| `fiscal.deadline.at_risk`               | a registration is still pending with less than 24 of the legal 48 hours left | `fiscalId`, `hoursLeft`                                      | the fiscal queue shows the urgency; nothing emits                       |
| `fiscal.certificate.expiring`           | a clinic's signing certificate ends within 30 days                           | `daysLeft`                                                   | `certificate_not_after` is stored; nothing reads it for this            |
| `message.send.failed`                   | an SMS, WhatsApp or Viber message fails                                      | `channel`, `code`                                            | on the reminder or send row; SMS and Viber are logged, WhatsApp is not  |
| `message.stuck`                         | a reminder stays in `sending` for more than 30 minutes                       | `channel`, `reminderId`                                      | deliberately not retried; nothing notices it                            |
| `whatsapp.connection.failed`            | a clinic's WhatsApp connection test fails                                    | —                                                            | `connection_status = 'failed'` on the row                               |
| `scheduler.sweep.completed` / `.failed` | the 15-minute Cron Trigger (reminders and fiscal retries) finishes or throws | `job`, `durationMs`, `tenantsFailed`                         | failures are logged per clinic; there is no heartbeat                   |
| `backup.completed` / `backup.failed`    | a backup finishes or fails (`db:backup`, or the provider's report)           | `bytes`, `tables`, `rows`                                    | `db:backup` exits non-zero on failure; nothing records success          |

**How it will be implemented, once the provider is chosen:** one small injectable with a single `emit(event)` method. By default it writes one JSON line through the existing logger, which works on both runtimes and needs no provider at all. The emit calls go at the sources listed in the "Today" column, most of which already catch the failure and only need to name it. A provider's SDK, if one is chosen, is an adapter behind the same method. Nothing else in the application should know which provider it is.

## 3. Requirements, signal by signal

### 3.1 API health

- **Watch:** an external uptime probe on `GET /api/health` through the public API hostname and through one clinic hostname. That second one proves the SPA's service binding too. Probe every minute, from at least two regions.
- **Today:** the endpoint answers 200 with `"database":"up"`, and 503 when the database is unreachable. The CI `compose` job checks both. No probe exists.
- **Alert:** two consecutive failures → **page**. The 503 body names the failing check.

### 3.2 Worker and API errors

- **Watch:** the rate of 5xx responses and of unhandled errors, grouped by `route` and `errorName`.
- **Today:** Workers Logs at full sampling (`observability` in `wrangler.jsonc`), and JSON logs with request ids on the container, with `authorization` and `cookie` redacted. There is no grouping, no alert, and no global filter that emits a structured event without the request body.
- **Alert:** 5xx above 1% of requests over 5 minutes, or more than 10 in 5 minutes → **page**. A new `errorName` never seen before → ticket.

### 3.3 Authentication failures

- **Watch:** failed sign-ins, account locks, address locks and second-factor locks, on both the clinic plane and the console.
- **Today:** failures are counted durably in `auth_throttle`: 10 per account and 100 per address in 15 minutes, keyed by HMAC so the table holds no email or IP. Second factors lock after five failures. None of this is logged, so no one would see a credential-stuffing run until users complain.
- **Alert:** any console (platform) account lock → **page**, since there are few console accounts and each one is powerful. Any address lock → warn. More than 5 clinic account locks in 15 minutes, fleet-wide → warn. A failure rate five times the weekly baseline → warn.

### 3.4 Fiscalization failures

- **Watch:** registrations that fail, that are refused, and that approach the legal 48-hour limit. Also cash declarations and certificates close to expiry.
- **Today:** each registration is a `fiscal_invoices` row with its status. The fiscal queue page shows urgency (routine, watch, urgent, overdue). CIS refusals are logged as warnings and scheduler errors as errors. Nothing alerts, and a clinic learns of a problem only by opening the queue.
- **Alert:** a registration pending with less than 24 hours left → **page** NODE X support, and notify the clinic's administrator. A refusal → notify the clinic, because the invoice must be corrected, which is a person's decision. The fiscal sweep failing for a clinic three times in a row → warn. A certificate within 30 days of `certificate_not_after` → notify the clinic. A cash declaration failure → warn.

### 3.5 WhatsApp and message failures

- **Watch:**
  - failed sends per channel (SMS, WhatsApp, Viber);
  - reminders stuck in `sending`;
  - broken WhatsApp connections;
  - whether the reminder sweep runs at all.
- **Today:**
  - WhatsApp failures are on `whatsapp_message_sends` with the reason, and a failed connection test sets `connection_status = 'failed'`. None of it is logged.
  - SMS and Viber attempts are logged.
  - An interrupted SMS attempt stays `sending` on purpose, and nothing notices it.
  - Viber delivery is never confirmed (see [SECURITY_AUDIT.md](./SECURITY_AUDIT.md#outstanding)).
- **Alert:**
  - No `scheduler.sweep.completed` for two intervals (30 minutes) → **page**. Missed reminders become missed appointments.
  - More than 20% of a clinic's sends failing in a day → notify the clinic.
  - A WhatsApp connection failure → notify the clinic's administrator.
  - A reminder stuck in `sending` for 30 minutes → warn.

### 3.6 Database failures

- **Watch:**
  - reachability;
  - pool errors;
  - connection saturation;
  - storage;
  - the provider's own health, and Hyperdrive's.
- **Today:** health answers 503 when the database is down, pool errors are logged, and production refuses to start if the row-security check cannot be verified. There are no provider metrics, because no provider is chosen.
- **Alert:**
  - health 503 → **page** (see 3.1);
  - pool errors above 5 a minute → **page**;
  - storage above 80%, or connections above 80% of the limit → warn.

### 3.7 Backup failures

- **Watch:** that a backup succeeded in the last day, that its size is plausible, and that a restore is rehearsed on schedule.
- **Today:** `db:backup` and `db:restore` exist. The restore refuses a non-empty target and checks the schema, every row count, the migrations and row security. It was rehearsed once, locally, on 2026-09-28. The provider's automated backups are not configured, and nothing records a success.
- **Alert:**
  - No successful backup in 26 hours → **page**.
  - A backup more than 50% smaller than the previous one → warn, since that pattern is a silent truncation.
  - A monthly restore rehearsal missed → ticket.

### 3.8 Alert ownership

**Required before production:** a named person in every row. A role is not enough.

| Alert class                             | Primary owner          | Backup | Channel            | Response target                                 |
| --------------------------------------- | ---------------------- | ------ | ------------------ | ----------------------------------------------- |
| API down, 5xx, database, backups        | _to be named_ (NODE X) | _TBD_  | page (phone + SMS) | acknowledge in 15 min, 08:00–20:00 Tirana       |
| Console account locked                  | _to be named_ (NODE X) | _TBD_  | page               | acknowledge in 15 min                           |
| Sign-in attack patterns                 | _to be named_ (NODE X) | _TBD_  | ticket             | next business day                               |
| Fiscal deadline at risk                 | _to be named_ (NODE X) | _TBD_  | page + clinic      | same day; the legal clock is 48 hours           |
| Fiscal refusal, certificate expiry      | the clinic's admin     | NODE X | in-app + email     | the clinic decides; NODE X follows up in 2 days |
| Messaging failures, WhatsApp connection | the clinic's admin     | NODE X | in-app + email     | same day                                        |
| Scheduler heartbeat missing             | _to be named_ (NODE X) | _TBD_  | page               | acknowledge in 15 min                           |

Out of hours (20:00–08:00 Tirana) a page waits for the morning, except "API down" and "backup failed". Which of those two wake someone is part of choosing the owner.

## 4. Choosing the provider

These are the criteria, not a choice:

- **Both runtimes.** It must ingest Workers Logs (Logpush or tail) and the container's JSON stdout, or offer an SDK for both.
- **EU data residency and a data processing agreement.** Event metadata is patient-adjacent, even with no patient data in it. The legal side belongs to the review in [PRIVACY_RETENTION_CHECKLIST.md](./PRIVACY_RETENTION_CHECKLIST.md).
- **Scrubbing on by default:** no request bodies, no headers beyond an allowlist.
- **Uptime probes from several regions,** and alert routing to phone, SMS and email with on-call rotation.
- **Cost** at the expected fleet size.

## 5. Checklist

- [x] A truthful health endpoint (503 when the database is down), proven in CI.
- [x] Request ids on every log line, secrets redacted, and no patient data in logs.
- [x] Workers observability at full sampling.
- [ ] Provider chosen (§4).
- [ ] The event interface in §2 implemented, with a test that no event carries a field outside the contract.
- [ ] An uptime probe on `/api/health` (§3.1).
- [ ] Every alert rule in §3 configured, and each one fired once on staging to prove it reaches its owner.
- [ ] Every row of §3.8 has a named person.
