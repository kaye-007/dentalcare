# DentalCare by NODE X

Multi-tenant SaaS for dental clinics in Albania. One shared deployment;
each clinic is a tenant reached by its own subdomain. Internal clinic-staff
system only (no patient portal, no public site in MVP).

## Apps

- `apps/api` — NestJS API (clinic plane + platform plane)
- `apps/tenant-web` — clinic SPA (owner / reception)  → http://localhost:5173
- `apps/admin-web` — superadmin SPA (NODE X control)   → http://localhost:5174

## Two planes, two DB roles

- **Clinic plane** uses `app_user` (non-superuser) — Row-Level Security enforced,
  scoped by `app.current_tenant_id`.
- **Platform plane** (superadmin) uses the privileged admin connection — it
  operates across all tenants (list / create / suspend) and so bypasses RLS.
  It is reachable only behind the superadmin guard.

## Run it (local)

```bash
cp .env.example .env          # Windows: Copy-Item .env.example .env
docker compose up -d postgres redis
npm install
npm run migrate:up
npm run seed
npm run api:dev               # terminal 1 → API on :3000
npm run web:dev               # terminal 2 → clinic SPA on :5173
npm run admin:dev             # terminal 3 → superadmin SPA on :5174
```

### Logins

Superadmin (admin-web, :5174): `admin@nodex.al` / `Admin123!`

Clinics (tenant-web, :5173 — defaults to avicena):

| Clinic         | Owner            | Reception           | Passwords                 |
|----------------|------------------|---------------------|---------------------------|
| Avicena Clinic | owner@avicena.al | reception@avicena.al (Frontdesk) | Owner123! / Reception123! |
| Smile Studio   | owner@smile.al   | reception@smile.al (Frontdesk)   | Owner123! / Reception123! |

## Reminders (M10) — how it works

A background scheduler inside the API scans every `REMINDER_SCAN_INTERVAL_MS`
(default 60s) for scheduled appointments entering each clinic's reminder
window, creates an automatic reminder (max one per appointment — enforced by
a partial unique index, so scans are idempotent), and delivers it through the
active **channel**. The MVP channel is the **internal log**: reminders are
recorded and visible in Reservations → Reminders; no SMS/email is sent and
the UI says so explicitly. SMS/email providers implement the same
`ReminderChannel` interface (`apps/api/src/tenant/reminders/channels/`) and
plug in without schema or UI changes. Manual reminders can be sent from any
scheduled appointment by owner or reception; settings (enable + timing) are
owner-only.

## Milestone status

- [x] M1 — app shell & dashboard UI foundation
- [x] M2 — auth & roles
- [x] M3 — tenant resolution & isolation (RLS, app_user, subdomain routing, suspended gate)
- [x] M4 — superadmin tenant management (list, create, owner+plan+trial, status, audit log)
- [x] M5 — patients (list, create/edit, profile, contact info, notes, search & filters)
- [x] UI consolidation pass — unified design system, semantic status pills, shared PageHeader/EmptyState/Modal, live dashboard
- [x] M6 — reservations / appointments (day/week calendar, booking, overlap protection, statuses)
- [x] M7 — treatments & medical record (catalog with owner-only pricing, odontogram, per-tooth records)
- [x] Correction pass — real Staff management, real Settings (profile/hours/preferences), arch-based SVG odontogram
- [x] M8 — invoices / payments / expenses (line items, partial payments, auto status, expenses, finance summary)
- [x] M9 — reports (owner-only analytics: date ranges, monthly trend chart, revenue/expense/profit breakdowns)
- [x] M10 — reminders & final polish (scheduler, reminder log, manual trigger, owner settings, channel abstraction)
- [x] Correction pass 2 — Owner/Frontdesk roles only, staff positions + salary payment log, optional treatment visit type, anatomical odontogram glyphs, minimal patient registration (first + last name only)
