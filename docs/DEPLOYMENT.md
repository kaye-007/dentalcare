# Deployment

Everything runs on Cloudflare. The container path is kept, tested and
supported as a fallback — see the last section.

| Component         | Target                                          | Notes                                                                 |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| `apps/tenant-web` | Worker + static assets, `*.dentalcare.com/*`    | One clinic per subdomain. Proxies `/api/*` to the API Worker.         |
| `apps/admin-web`  | Worker + static assets, `admin.dentalcare.com`  | Same proxy, no tenant subdomain.                                      |
| `apps/api`        | Worker, `nodejs_compat`                         | NestJS over `httpServerHandler`. Hourly Cron Trigger for reminders.   |
| PostgreSQL        | Supabase, fronted by **two** Hyperdrive configs | RLS is the isolation boundary. Direct port 5432, not the 6543 pooler. |
| Patient documents | Any S3-compatible bucket (R2, S3, MinIO)        | Signed with `aws4fetch`; private bucket, pre-signed URLs only.        |

## What changed, and why it works now

`DEPLOYMENT.md` used to say the API was not adapted for serverless and should
not be. Two things made that true, and both have been dealt with:

- **The resident scheduler.** `ReminderSchedulerService` held a `setInterval`.
  On Workers it holds nothing; the Cron Trigger in `apps/api/wrangler.jsonc`
  calls `tick()` through the `scheduled` handler instead. The scan was already
  idempotent behind a partial unique index, so nothing about the logic moved.
- **The two persistent pg pools.** A Worker may not reuse a socket opened
  during a different request. `DatabaseService` now keeps resident pools only
  on Node; on Workers each operation borrows a single connection from
  Hyperdrive and closes it. Callers see the same `PoolClient` on both, so no
  service knows which runtime it is on.

The third obstacle was size. A Worker bundle is capped at 3 MiB compressed on
the free plan and `@aws-sdk/client-s3` alone did not leave room for NestJS, so
object storage was rewritten over `aws4fetch` — a few kilobytes, WebCrypto
SigV4, identical on both runtimes. **The API Worker currently bundles to
2477 KiB raw / 708 KiB gzipped.**

### Five things that only showed up by running it

Bundling successfully proves nothing. Every one of these compiled, passed
`wrangler deploy --dry-run`, and then threw on the first request:

| Symptom                                                        | Cause                                                                                                                                      | Fix                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `Cannot read properties of undefined (reading 'stringifySym')` | wrangler's bundler honours npm `browser` fields; pino's browser build exports no `symbols`, which pino-http reads at module scope          | pino runs on Node only; `worker/stubs/pino-logger.js` stands in            |
| `require_streams(...) is not a function`                       | same cause — `iconv-lite` maps `./lib/streams` to `false` for browsers, and body-parser pulls it in, so **every request with a body** died | pre-bundle with `platform: 'node'`, where browser fields are not consulted |
| `Code generation from strings disallowed`                      | Express 4's `depd` builds deprecation wrappers with `new Function`, which Workers forbid                                                   | `worker/stubs/depd.js` — it only suppressed warnings anyway                |
| `Class extends value #<Object> is not a constructor`           | pinning esbuild `mainFields` to `module,main` picked pg's ESM wrapper, whose re-export leaves `Pool` a plain object                        | don't override `mainFields`; `platform: 'node'` is enough                  |
| `CloudflareSocket is not a constructor`                        | `pg-cloudflare` exports its real socket only under the `workerd` export condition                                                          | add `conditions: ['workerd']` to the pre-bundle                            |

The first four are open wrangler bug [workers-sdk#9309](https://github.com/cloudflare/workers-sdk/issues/9309)
and the platform's eval ban. None is exotic; all of them are the first request
in production if nobody runs the thing first.

---

## 1. Database first

```bash
# 1. Provision Postgres, then point DATABASE_URL at it (privileged role).
# 2. Run migrations — these create the app_user role.
npm run migrate:up
```

The baseline migration reads `APP_DB_USER` / `APP_DB_PASSWORD` and creates a
`NOSUPERUSER … NOBYPASSRLS` role. **Avoid single quotes in the password** —
the migration interpolates it into `CREATE ROLE` SQL.

Migrations run from your machine or CI against Supabase directly. They are not
run from the Worker.

#### A database created before the migration squash

The history `0001…0021` was replaced by a single generated `0001_baseline`
that produces a byte-identical schema. A **new** database needs nothing
special. A database that already ran the old history needs one flag, once:

```bash
npm run migrate:up -- --no-check-order
```

Without it node-pg-migrate refuses, because `0001_baseline` sorts before
migrations it has already applied — a sound default, and exactly what a squash
creates. With it, the baseline sees the schema is already there, checks that
**all** 21 superseded migrations were applied, converges the role, records
itself, and changes nothing else.

A database that ran only _some_ of the old migrations is refused outright,
naming the first one missing. Bring it up to date from a checkout made before
the squash and then run the command above.

Re-verify the baseline reproduces the schema at any time:

```bash
npm run migrate:baseline -- --verify
```

### First platform administrator

Migrations create schema only — the database starts with no accounts. Create
the first NODE X superadmin by hand; every clinic and clinic user is created
from the platform console afterwards.

Generate a bcrypt hash (work factor 10, matching
`apps/api/src/core/security/bcrypt.ts`):

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" 'a-long-random-passphrase'
```

Insert the account using the **privileged** connection — `platform_admins`
carries no RLS and `app_user` is revoked from it:

```sql
INSERT INTO platform_admins (email, password_hash, full_name, status)
VALUES ('you@company.com', '<paste-the-hash>', 'Your Name', 'active');
```

Email uniqueness is enforced case-insensitively by
`platform_admins_email_lower_unique`. To rotate the password later, `UPDATE`
the `password_hash` column with a freshly generated hash.

### Upgrading an existing database (migrations 0003–0008)

Run migrations **before** deploying the code that needs them, and read these
first — three of them change data or contracts, not only schema:

- **0005 drops the plaintext `totp_*` columns** and refuses to run if any of
  them hold data. Refresh tokens become server-side sessions, so every signed-in
  user signs in again after the deploy.
- **0006 multiplies every stored amount by 100** (whole units → cents) and
  refuses to run if any clinic holds money in more than one currency. The API
  contract changes with it: every amount in a request or response is minor
  units. Deploy the API and both SPAs together. Its down migration refuses once
  any amount has cents.
- **0008 revokes DELETE on `reminders`** and sets every existing clinic's
  reminder time zone to `Europe/Tirane` — change it in Settings for a clinic
  elsewhere.

All six were run down and up again against a development database on
2026-09-14.

### Upgrading an existing database (migrations 0009–0012)

**Run on 2026-09-17 against a fresh PostgreSQL 16**: 0001–0012 up, 0012 down
and up, the 0012 backfill on existing reminder rows, and the full integration
suite. Not yet run against a copy of production data — do that, with
`migrate:down` and `migrate:up` again, before this branch is merged.

- **0012 turns reminders into patient messages.** Existing rows get their
  patient from the appointment. It adds `id_document`, the `messages`
  access-log resource, the estimate quote currency (EUR for every clinic in
  lek) and the `fx_rates` cache. Its down migration refuses while any
  follow-up or balance notice exists.

- **0009 narrows reminder timing to 12 or 24 hours.** Existing values of 18
  hours or less become 12, the rest 24. Adds `schedule_closures` and
  `patient_imports` (both RLS-forced), the clinic profile, finance and channel
  columns, patients' national ID (unique per clinic), preferred channel and
  profile photo, document photo tags, payment method labels and reminder
  template values.
- **0010 adds fiscalization** — settings, counters, registrations, cash
  declarations — and two triggers: an invoice registered with the tax
  authority cannot be cancelled, and a payment on one cannot be voided. Its
  down migration refuses once any production registration exists.
- **0011 adds the `deleted` tenant status** with its restore window. Its down
  migration refuses while any clinic is deleted.

The API change that goes with 0009 withdraws `clinical:write` from
reception; tell clinics before deploying.

## 2. Two Hyperdrive configs

The tenant plane and the platform plane connect as **different database
roles**, and that difference is the entire isolation model. One Hyperdrive
config per role, never one shared:

```bash
wrangler hyperdrive create dentalcare-app --caching-disabled \
  --connection-string="postgres://app_user:PASSWORD@db.PROJECT.supabase.co:5432/postgres"

wrangler hyperdrive create dentalcare-admin --caching-disabled \
  --connection-string="postgres://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres"
```

Paste the two ids into `apps/api/wrangler.jsonc`, replacing
`REPLACE_WITH_HYPERDRIVE_APP_ID` and `REPLACE_WITH_HYPERDRIVE_ADMIN_ID`.

Three things here are not optional:

- **`--caching-disabled`.** Hyperdrive's result cache is keyed on the query
  text, not on the transaction that set `app.current_tenant_id`. With caching
  on, one clinic's rows can be served to another. Caching is a property of the
  config, not of the binding, so it can only be set here.
- **Port 5432, the direct host.** Not Supabase's 6543 transaction pooler.
  Hyperdrive _is_ the pooler, and `set_config('app.current_tenant_id', …, true)`
  needs the session that a transaction-mode pooler will not keep.
- **`app_user`, not `postgres`, on `dentalcare-app`.** The API verifies this at
  boot: if the tenant role turns out to be a superuser or to hold `BYPASSRLS`,
  it refuses to start in production rather than serve unisolated data.

## 3. Secrets

Non-secret configuration lives in `vars` in `apps/api/wrangler.jsonc`. Anything
sensitive is a Worker secret:

```bash
cd apps/api
wrangler secret put JWT_SECRET            # >= 32 chars, not the example value
wrangler secret put PLATFORM_JWT_SECRET   # >= 32 chars, different from JWT_SECRET
wrangler secret put MFA_ENCRYPTION_KEYS   # "k1:<base64 of 32 bytes>" — seals TOTP secrets
wrangler secret put TWILIO_AUTH_TOKEN     # only with SMS_PROVIDER=twilio
wrangler secret put GOOGLE_CLIENT_ID      # optional — all three or none
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_CALLBACK_URL
wrangler secret put S3_BUCKET             # optional — all three or none
wrangler secret put S3_ACCESS_KEY_ID
wrangler secret put S3_SECRET_ACCESS_KEY
wrangler secret put S3_ENDPOINT           # set for R2/MinIO, omit for AWS S3
```

The API validates every variable at boot and **refuses to start** on a bad
config rather than running unsafely:

| Variable                                   | Failure if wrong                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_DATABASE_URL` (from `HYPERDRIVE_APP`) | Missing → boot refused. Points at a superuser or `BYPASSRLS` role → boot refused. Either would silently disable RLS and expose every clinic's data to every other clinic. |
| `JWT_SECRET`                               | Missing, under 32 chars, or the `.env.example` placeholder → boot refused.                                                                                                |
| `DATABASE_URL` (from `HYPERDRIVE_ADMIN`)   | Missing → boot refused.                                                                                                                                                   |
| `NODE_ENV`                                 | Must be `production`. It disables the client-supplied tenant header and switches logging to JSON.                                                                         |
| `RUNTIME`                                  | `workers` on Cloudflare, `node` in the container. Chooses the connection strategy and silences the in-process scheduler.                                                  |

Added with migrations 0005–0008:

| Variable | Failure if wrong |
| --- | --- |
| `MFA_ENFORCEMENT` | Anything but `required` in production → boot refused. |
| `MFA_ENCRYPTION_KEYS` | Missing or malformed in production → boot refused. Lost entirely → every enrolled user needs a two-step reset by an administrator. |
| `PLATFORM_JWT_SECRET` | Missing, under 32 chars, or equal to `JWT_SECRET` in production → boot refused. |
| `SMS_PROVIDER` | `log` (default) sends nothing. `twilio` without `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and a sender (`TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID`) → boot refused. |
| `PUBLIC_API_URL` | Required in production with `twilio`. Must be the exact origin Twilio calls, with no path: receipt signatures are checked against it, so a wrong value makes every receipt a 403. |
| `REMINDER_SCAN_BUDGET_MS` | How long one reminder pass may run (default 45s). Keep it under the cron interval. |

## 4. Deploy

Order matters — both SPA Workers hold a service binding to the API Worker, so
it has to exist first.

```bash
npm run cf:dry-run    # bundles all three, uploads nothing
npm run cf:deploy     # api → tenant-web → admin-web
```

`cf:deploy` on the API runs `npm run build:worker` first, which is three
steps, and each one exists for a reason:

1. **`nest build`** — tsc compiles the application to `dist/`. NestJS needs
   `emitDecoratorMetadata` for constructor injection and esbuild cannot emit
   it, so the application can never be compiled by a bundler alone.
2. **`scripts/build-worker.mjs`** — esbuild flattens `dist/` and its
   dependencies into one CommonJS file with `platform: 'node'` resolution.
   That is what keeps npm `browser` fields out of the picture. Read the header
   of that file before changing any option in it.
3. **`wrangler deploy`** — wrangler bundles `worker/index.ts` around that
   single file, which leaves it nothing to resolve but node builtins — the
   part it does well.

`worker/stubs/` holds three small stand-ins: `nest-optional.js` for
`@nestjs/websockets` and `@nestjs/microservices` (Nest requires both
optionally and guards every use), `pino-logger.js`, and `depd.js`. Each carries
its own explanation.

### Domains and routing

- `apps/tenant-web` → route `*.dentalcare.com/*` (wildcard DNS + wildcard TLS)
- `apps/admin-web` → custom domain `admin.dentalcare.com`
- `apps/api` → custom domain `api.dentalcare.com`

More specific routes win, so the two custom domains are not swallowed by the
wildcard. The apex is deliberately unrouted: the clinic app needs a subdomain
to resolve a tenant.

**`/api/*` is same-origin on purpose.** Each SPA Worker forwards it to the API
over a service binding rather than letting the browser call
`api.dentalcare.com` directly. The API reads the clinic from the first label of
the `Host` header — `avicena.dentalcare.com` → `avicena` — and the
`X-Tenant-Subdomain` override is hard-disabled in production. A cross-origin
call would arrive with the wrong host and resolve no clinic at all. Keeping the
hop internal also means no CORS preflight and no token leaving its origin.

`api.dentalcare.com` exists for one reason: Google allows a single fixed
redirect URI, so `GOOGLE_CALLBACK_URL` needs a stable public host.

### Reminders

`"triggers": { "crons": ["*/15 * * * *"] }` runs the reminder pass every 15
minutes. Each pass stops after `REMINDER_SCAN_BUDGET_MS` and visits clinics in
the order they were last scanned, so a slow clinic cannot starve the others.
Run it by hand to test:

```bash
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*%2F15+*+*+*+*"
```

**Sending SMS.** Off by default. To turn it on:

1. In Twilio, buy a number (or create a Messaging Service) that can send to
   the clinics' countries.
2. Set `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, and `TWILIO_FROM` or
   `TWILIO_MESSAGING_SERVICE_SID` in `vars`, and `TWILIO_AUTH_TOKEN` as a
   secret.
3. Set `PUBLIC_API_URL` to the API's public origin. Each message asks Twilio to
   report delivery to `/api/reminders/delivery/twilio` on it; the request is
   refused unless its `X-Twilio-Signature` matches.

Each clinic sets its time zone, message language, own wording and the country
code for numbers written the local way in Settings → Appointment reminders.
The built-in message names the patient's first name, the clinic and the time —
never the treatment.

**How delivery behaves**, so the reminder log reads correctly:

| Status | Meaning |
| --- | --- |
| `sent` | Twilio accepted it. Not proof it arrived. |
| `delivered` | The carrier confirmed it (needs `PUBLIC_API_URL`). |
| `pending` with a retry time | Twilio answered 429 or 503. Tried again after 5, then 30 minutes; three attempts in all. |
| `failed` | Refused, out of attempts, or no clear answer. Timeouts and other 5xx are **not** retried — the message may have gone, and a patient texted twice is worse than a failure staff can see. |
| `skipped` | Not sent on purpose: opted out, no usable mobile number, or the appointment stopped being upcoming. |
| `sending` | An attempt was interrupted between the provider call and recording it. Never retried automatically. Check Twilio's message log for that number and time. |

A patient who replies STOP is marked as opted out when the receipt (or the next
send) reports Twilio error 21610; staff can also untick them on the patient
form.

**WhatsApp and Viber.** Each clinic picks a default channel in Settings →
Reminders, and a patient can pick their own on the patient form. A channel
this deployment cannot send on falls back to SMS, then to the log; the reminder
row records the channel actually used.

- *WhatsApp (Twilio).* WhatsApp only lets a business open a conversation with
  wording Meta has approved, so the clinic's own text is not used. Register a
  WhatsApp sender in Twilio, create one Content template per language with five
  variables in this order — first name, date, time, dentist, clinic — and get
  them approved. Then set `WHATSAPP_PROVIDER=twilio`, `TWILIO_WHATSAPP_FROM`
  and `TWILIO_WHATSAPP_CONTENT_SIDS="en:HX…,sq:HX…"`. Receipts arrive at the
  same signed Twilio endpoint as SMS.
- *Viber (Vonage).* Create a Viber Service Message sender with Vonage and set
  `VIBER_PROVIDER=vonage`, `VONAGE_API_KEY`, `VONAGE_VIBER_SENDER`, and
  `VONAGE_API_SECRET` as a secret. The clinic's own wording is sent. Delivery
  status is not received yet, so the log shows Viber reminders as sent only.

Neither has been exercised against a live account.

### Fiscalization (Albania)

Built to the DPT CIS schema and checked against an independent XML-DSig
implementation. **Not yet exercised against the authority's test service.** Do
that, end to end, before any clinic turns on the production environment.

1. **The software code.** Every fiscal invoice carries the code the authority
   issued to the maker of the software. Set `FISCAL_SOFTWARE_CODE`; without it
   the settings screen reports fiscalization as unavailable.
2. **Endpoints.** `FISCAL_CIS_URL_TEST`, `FISCAL_CIS_URL_PRODUCTION` and the two
   verification-portal URLs default to the published addresses. Confirm them,
   and the `SOAPAction` values in `fiscal.service.ts`, against DPT's current
   service description.
3. **Per clinic, in Settings.** The clinic's NIPT, address and city on the
   profile; lek as the currency; the business unit and cash register (TCR)
   codes it registered; its signing certificate — the .p12/.pfx file as issued,
   with its password, which opens it on the server and is not kept (a PEM is
   still accepted); an operator code for each person who issues invoices. The
   certificate's private key is sealed with `MFA_ENCRYPTION_KEYS` on arrival
   and never returned.
4. **Test first.** Leave the clinic on the test environment, issue a cash and a
   non-cash invoice, declare opening cash, and confirm on the test verification
   portal that the QR code resolves. Test invoices print a TEST banner.
5. **Daily.** Reception declares the opening cash before the first cash
   invoice (Settings → Fiscalization → Cash in the register).

How a registration behaves:

| Status | Meaning |
| --- | --- |
| `pending` | Signed and numbered. The NSLF and QR are valid and print now. The Cron Trigger resends it as a subsequent delivery (1, 2, 4 … 60 minutes apart) until CIS answers. The law allows 48 hours. |
| `fiscalized` | CIS returned the NIVF. |
| `rejected` | CIS answered with a fault. The request and response XML are kept on the row for support. |

Receipts print from the invoice screen (**Fiscal receipt**), sized for an
80 mm printer. Set the printer's paper to 80 mm roll; the page declares it.

Not built yet: corrective invoices, e-invoices (B2B through EIC), invoices in
currencies other than lek, and TCR registration from the app.

### Messages and estimates

- **WhatsApp templates per kind of message.** `TWILIO_WHATSAPP_CONTENT_SIDS`
  takes `sq:HX…` (appointment reminder), `followup.sq:HX…` and
  `balance.sq:HX…`, each approved by Meta with the variables listed in
  `channels/whatsapp.ts`. A kind without a template is not offered over
  WhatsApp; SMS, Viber and the hand-off still carry it.
- **Exchange rates** for EUR on estimates come from `FX_RATES_URL` (default:
  ExchangeRate-API's open endpoint, daily, attribution printed) and are cached
  in `fx_rates`; an outage prints the last rate with its date. Clinics can
  use a fixed rate of their own instead. These are indicative quotes, never
  used for booking or fiscalization.

### Backups and restore

The platform backup is the database provider's point-in-time recovery — enable
it and rehearse a restore to a new database before the first paying customer.
The console deliberately has **no** button that restores a database: a restore
into the live shared schema rolls back every clinic at once, and restoring one
clinic's rows means crossing append-only tables and locking triggers, which is
a supervised operation, not a click.

What the console does have:

- **Delete and restore a clinic.** Deletion is a status: access stops, nothing
  is removed, and the console can restore it (as suspended) for at least 30
  days. Nothing purges automatically.
- **Export clinic data.** An audited JSON snapshot of every row carrying the
  clinic's `tenant_id`, with passwords, second factors, sessions and signing
  keys left out, stamped with the last migration and a SHA-256 of its tables.
  Capped at 200,000 rows; export anything larger from a backup. Document files
  stay in the bucket under `tenants/<id>/` and are not in the JSON.

To recover one clinic's data from a backup: restore the backup to a separate
database, export the clinic from there with the same query the console uses,
and re-enter the missing records through the API with the clinic's
administrator present. Record what was restored in the clinic's activity trail.

## Local development

Two ways, both supported:

```bash
npm run api:dev     # plain Node against docker-compose Postgres — fastest loop
npm run cf:dev -w @dentalcare/api   # the real Workers runtime, via wrangler dev
```

`wrangler dev` uses the `localConnectionString` on each Hyperdrive binding, so
it talks to the same local Postgres without touching Supabase. Put secrets in
`apps/api/.dev.vars` (git-ignored) — at minimum `JWT_SECRET`.

Fire the cron by hand:

```bash
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*%2F15+*+*+*+*"
```

One caveat worth knowing before you chase a phantom bug: `wrangler dev`
presents every request as arriving at the **first route in
`wrangler.jsonc`**, regardless of the `Host` header you send. With the API's
route set to `api.dentalcare.com`, tenant resolution therefore reads `api` as
the clinic and answers `404 Clinic not found`. Point the route at a clinic
host for that test.

## Health, logging, observability

- `GET /api/health` — reports DB reachability.
- On the container, logs are JSON (pino) with `x-request-id` correlation and
  `authorization` / `cookie` redacted.
- On Workers, pino is not loaded at all (see the table above). `WorkersLogger`
  in `src/bootstrap.ts` routes Nest's logger at `console`, which is what
  Workers Logs reads, and a small middleware preserves the `x-request-id`
  contract that pino-http used to provide. `observability` is enabled in
  `wrangler.jsonc` at full sampling. Note that `wrangler dev`'s local log
  viewer records request events rather than console output — confirm log lines
  are arriving from the dashboard after the first deploy.
- **No patient data is written to the log.** The reminder log channel records
  the message on the reminder row, under RLS, and nothing about the patient in
  the application log — on Cloudflare that log leaves the database's trust
  boundary entirely.

## Scaling

The constraint that pinned the API to one replica is gone. The scheduler no
longer runs in-process, so Worker concurrency is unbounded from this
application's point of view; Hyperdrive owns the connection ceiling.

`withTenant()` sets `app.current_tenant_id` via `set_config(..., true)` —
**transaction-local**. Any pooler in front of Postgres must run in
**transaction mode**, and must not be stacked underneath Hyperdrive.

---

## Fallback: the container

`infra/docker/Dockerfile` and `infra/docker/docker-compose.yml` are unchanged
in substance and still work.
Nothing in the Cloudflare port removed the Node path — `RUNTIME` defaults to
`node`, which restores the resident pools and the in-process scheduler.

```bash
docker build -f infra/docker/Dockerfile -t dentalcare-api .
docker run -p 3000:3000 --env-file .env.production dentalcare-api
```

With the scheduler back in-process there is still no distributed lock, so the
container path remains **single-replica**. The duplicate-claim path is safe —
`reminders_auto_unique` refuses the second insert and each claim runs in its
own transaction — but a second replica is wasted work.

## Staging verification — required before any of this is believed

**The Workers deployment has never served a real request.** Everything below
has been verified statically: the bundles build, every binding resolves,
`wrangler deploy --dry-run` passes for all three Workers, and
`apps/api/test/integration/cloudflare-config.itest.ts` asserts the topology
that can be checked from configuration alone.

None of that is evidence the thing works. The table in
[Five things that only showed up by running it](#five-things-that-only-showed-up-by-running-it)
lists five failures that each compiled, each passed a dry run, and each threw
on the first real request. A dry run proves the shape of the deployment, not
its behaviour.

So this section is a checklist to be performed against a staging environment,
not a description of a system known to work.

### What is verified statically

| Property                                                     | How                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| Three Workers bundle                                         | `npm run cf:dry-run`, in CI on every push                |
| Every binding resolves                                       | same — wrangler fails a dry run on an unresolved binding |
| Two distinct Hyperdrive configs                              | `cloudflare-config.itest.ts`                             |
| Tenant plane binds `app_user`, platform plane the owner role | same                                                     |
| `NODE_ENV=production`, so the tenant header override is dead | same                                                     |
| `ALLOW_TENANT_HEADER` unset                                  | same                                                     |
| Direct port 5432, never the 6543 pooler                      | same                                                     |
| No secret in `vars`                                          | same                                                     |
| Both SPAs proxy `/api` by service binding                    | same                                                     |

### What can only be verified on staging

Work down this list in order. Each step's failure mode is named, because
every one of them looks like something else from the outside.

- [ ] **Both Hyperdrive configs created with `--caching-disabled`.**
      Caching lives on the config, not on the binding, so nothing in this
      repository can assert it. Hyperdrive's result cache is keyed on the
      query, not on the transaction that set `app.current_tenant_id` — a
      cached row from one clinic can be served to another. Confirm with
      `npm run cf:check-caching -w @dentalcare/api`, which asks the account
      about each id in `wrangler.jsonc` and fails unless caching is disabled
      on both — or by hand with `wrangler hyperdrive get <id>`. The script
      needs a logged-in wrangler and has not yet been run against a real
      account; if its output cannot be read it says UNVERIFIED and fails.
      _This is the single highest-consequence item on the page._

- [ ] **`HYPERDRIVE_APP` points at `app_user`, not the owner role.**
      The API refuses to boot in production if the tenant role is a superuser
      or holds BYPASSRLS (`DatabaseService.assertTenantRoleIsRestricted`), so
      the symptom is a failed deploy, not a silent leak. Check the boot log
      shows no RLS warning.

- [ ] **The Worker serves one real request.** `GET /api/health` through the
      deployed hostname. 200 with `"database":"up"`.

- [ ] **Two clinics, isolated, on staging.** Create two, sign in to each, and
      repeat by hand what `tenant-isolation.itest.ts` and
      `api-tenant-binding.itest.ts` do locally: A cannot list B's patients,
      A's token on B's host is 401, and `GET /patients/{B's patient}` as A is 404. Passing locally proves the policies; passing here proves the
      Hyperdrive path preserves the session state the policies depend on.

- [ ] **Google sign-in, end to end, on the deployed Worker.** The callback is
      the one route that arrives on the API host with no clinic subdomain and
      resolves its clinic from a signed `state` parameter. It has never run
      outside a local process.

- [ ] **A document upload, against the real bucket.** Object storage was
      rewritten over `aws4fetch` for bundle size; the SigV4 signing path has
      never been exercised against S3 or R2 from a Worker.

- [ ] **The Cron Trigger fires once.** The reminder sweep moved from an
      in-process `setInterval` to a Cron Trigger. Observe one invocation in
      the dashboard.

- [ ] **One real SMS, and its receipt.** The Twilio channel has only ever
      talked to a local stand-in and been checked against Twilio's published
      signature example. Send a reminder to a staff phone from the appointment
      screen, then confirm the log moves from Sent to Delivered. A 403 in the
      Worker log on `/api/reminders/delivery/twilio` means `PUBLIC_API_URL` is
      not the origin Twilio called.

- [ ] **Two-step sign-in on the deployed Worker.** Enrol an administrator with
      an authenticator app, sign out, sign in with a code, then with a
      recovery code. Confirm `MFA_ENCRYPTION_KEYS` is the secret you backed up.

- [ ] **A backup restored.** Not "backups are enabled" — a restore actually
      performed into a scratch database and the schema diffed against
      `npm run migrate:baseline -- --verify`.

Until every box above is ticked, this deployment is unproven. Do not describe
it as production ready, and do not put a real clinic's records on it.

## Before first paying customer

- [ ] `NODE_ENV=production`, `JWT_SECRET` rotated off any shared value
- [ ] Both Hyperdrive configs created with `--caching-disabled`
- [ ] `HYPERDRIVE_APP` verified as `app_user` — boot logs no RLS warning
- [ ] Automated backups enabled, **and a restore rehearsed**
- [ ] Wildcard DNS + TLS in place for `*.dentalcare.com`
- [ ] Superadmin created manually, not seeded
- [ ] Cron Trigger observed firing once in production
- [ ] Google sign-in exercised end to end on the deployed Worker
- [ ] Uptime and error alerting on `/api/health`
- [ ] `MFA_ENCRYPTION_KEYS` stored somewhere other than Cloudflare
- [ ] Every clinic's reminder time zone checked after migration 0008
- [ ] SMS sent and delivered once on production, if `SMS_PROVIDER=twilio`
- [ ] Migrations 0009–0011 run down and up on a copy of production data
- [ ] WhatsApp / Viber reminder received on a real phone, if enabled
- [ ] A fiscal invoice registered on DPT's test service and verified by QR
- [ ] Clinic export downloaded and its SHA-256 checked for one clinic
- [ ] Reception accounts told that charting and treatment plans moved to clinical staff
