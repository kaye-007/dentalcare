# Pre-push inventory

Inventory of the uncommitted DentalCare work taken **before** the preservation
commit, on 2026-09-26. Its only purpose is to record exactly what was
preserved. Nothing was changed, formatted, renamed or deleted to produce it.

- **Base commit:** `2fb91f5` (`production-hardening`), which descends from `origin/main` (`0e88c3d`) by 38 commits
- **Preservation branch:** `preserve/pre-production-sept-9-18`, created from exactly `2fb91f5` with the working tree as it was
- **Staged changes before the commit:** none
- **Stashes:** none
- **Remote state before the push:** `origin` held only `main` (`0e88c3d`, "Add project files"). Neither `production-hardening` nor its 38 commits had been pushed.

## Summary (machine-readable)

```json
{
  "date": "2026-09-26",
  "base_commit": "2fb91f5",
  "base_branch": "production-hardening",
  "preservation_branch": "preserve/pre-production-sept-9-18",
  "tracked_modified": 166,
  "tracked_deleted": 4,
  "tracked_staged": 0,
  "tracked_lines_added": 28453,
  "tracked_lines_deleted": 7182,
  "untracked_files": 214,
  "untracked_text_lines": 43019,
  "untracked_binary_files": 4,
  "approx_total_lines_added": 71472,
  "generated_files_to_commit": 0,
  "secrets_to_commit": 0,
  "migrations_total": 16,
  "migrations_untracked": 15,
  "integration_suites_total": 27,
  "integration_suites_untracked": 14,
  "unit_suites": 43,
  "unit_tests": 695
}
```

`untracked_text_lines` includes the two audit documents written the same day
(`docs/CLAUDE_AUDIT.md`, `docs/CLAUDE_EXECUTION_PLAN.md`, about 450 lines) and
this file.

## Classification

| Class | Count | Notes |
|---|---|---|
| Tracked, modified | 166 | +28,453 / −7,182 lines |
| Tracked, deleted | 4 | the Shqip i18n layer: `LanguageToggle.tsx`, `lib/i18n/{en,sq,index}` |
| Tracked, staged | 0 | |
| Untracked | 214 | 210 text files, 4 binary (`.p12` test fixtures) |
| Generated | 0 to be committed | `node_modules/`, every `dist/`, `.wrangler/` and `graphify-out/` are git-ignored (verified with `git check-ignore`) |
| Secrets / configuration | 0 real secrets | see [Secrets check](#secrets-check) |

## Migrations present

| Migration | State before commit |
|---|---|
| `0001_baseline.js` | tracked, **modified** (removes a pg_dump `ALTER DEFAULT PRIVILEGES` line) |
| `0002_inventory.js` | untracked |
| `0003_clinical-roles.js` | untracked |
| `0004_clinical-record-integrity.js` | untracked |
| `0005_sessions-and-mfa.js` | untracked |
| `0006_money-minor-units.js` | untracked |
| `0007_inventory-lots.js` | untracked |
| `0008_reminder-delivery.js` | untracked |
| `0009_clinic-operations.js` | untracked |
| `0010_fiscalization.js` | untracked |
| `0011_platform-lifecycle.js` | untracked |
| `0012_albanian-market.js` | untracked |
| `0013_foundations.js` | untracked |
| `0014_cash_drawer.js` | untracked |
| `0015_checkout_documents.js` | untracked |
| `0016_platform_billing.js` | untracked |

## Integration suites present (27)

Tracked before the commit (13): `api-acceptance`, `api-auth`, `api-clinical`,
`api-platform`, `api-tenant-binding`, `api-trial`, `cloudflare-config`,
`double-booking`, `privileges`, `role`, `spa-parity`, `tenant-isolation`,
`tenant-middleware`.

Untracked before the commit (14): `albanian-market`, `api-inventory`,
`api-inventory-lots`, `api-mfa`, `api-sessions`, `api-throttle`,
`cash-drawer`, `checkout`, `clinical-record`, `inventory`, `money`,
`platform-billing`, `platform-console`, `reminders-delivery`.

## Major feature directories affected

Directories whose files were **entirely** untracked (the feature existed only
on disk):

| Directory | Files |
|---|---|
| `apps/api/src/modules/clinic/fiscalization` | 24 |
| `apps/api/src/modules/clinic/inventory` | 10 |
| `apps/api/src/modules/clinic/cash-drawer` | 7 |
| `apps/api/src/core/mfa` | 7 |
| `apps/api/src/modules/clinic/features` | 5 |
| `apps/api/src/modules/platform/billing` | 5 |
| `apps/api/src/modules/platform/activity` | 4 |
| `apps/api/src/modules/platform/usage` | 4 |
| `apps/api/src/core/sessions` | 3 |
| `apps/api/src/core/money` | 2 |
| `apps/api/src/core/pdf` | 2 |
| `apps/api/src/core/entitlements` | 1 |
| `apps/api/src/core/idempotency` | 1 |
| `apps/api/src/core/request-context` | 1 |

Partly untracked: `core/audit`, `core/config`, `clinic/billing`,
`clinic/documents`, `clinic/finance`, `clinic/patients`, `clinic/reminders`,
`clinic/settings`, `platform/plans`; 10 new modules in `packages/shared/src`
(cash-drawer, csv, features, messages, money, patient-import, reminders, vat,
each with a spec); 20 new tenant-web components and 7 pages; 7 new admin-web
components and 5 pages.

Modified tracked files by area: `apps/api/src` 78, `apps/tenant-web/src` 41,
`apps/admin-web/src` 10, `apps/api/test` 8, `docs` 6, `packages/shared` 4,
`apps/api/worker` 3, root configuration and scripts the rest.

## Secrets check

Every file that would be committed (tracked + untracked, 552 paths) was
scanned by name and by content. No values are reproduced here.

| File | Key / item | Real credential? |
|---|---|---|
| `.env` | all keys | **not committed.** Git-ignored, and absent from all git history |
| `.env.example` | `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `DATABASE_URL`, `APP_DATABASE_URL` | no. Documented local-dev defaults |
| `.env.example` | every other key | no. Empty or placeholder |
| `.env.production.example` | `DATABASE_URL`, `APP_DATABASE_URL` | no. Placeholder passwords on host `db.internal` |
| `.env.production.example` | `CORS_ORIGINS`, `PUBLIC_API_URL` | no. Placeholder domain `dentalcare.com` |
| `.github/workflows/ci.yml` | `DATABASE_URL`, `APP_DATABASE_URL` | no. Throwaway CI database credentials |
| `apps/api/wrangler.jsonc` | Hyperdrive `id` ×2 | no. `REPLACE_WITH_…` placeholders |
| `apps/api/wrangler.jsonc` | `localConnectionString` ×2 | no. The same local-dev defaults as `.env.example` |
| `apps/api/wrangler.jsonc`, `docs/DEPLOYMENT.md`, `apps/api/scripts/check-cloudflare-bindings.mjs` | example Supabase connection strings | no. `PASSWORD` / `PROJECT` placeholders |
| `apps/api/src/modules/clinic/auth/guards.spec.ts` | JWT `secret` | no. Test-only string |
| `apps/api/src/modules/clinic/fiscalization/__fixtures__/*.pem`, `*.p12` (9 files) | test certificate, keys, PKCS#12 bundles | no. Self-signed `CN=Klinika Test, O=Test Clinic, serialNumber=L12345678A` (dummy NIPT) and `CN=Someone Else`. Every `.p12` opens with the spec's test password to that same test certificate |
| `apps/api/src/core/mfa/secret-box.ts`, `apps/api/src/modules/platform/auth/platform-secret.ts` | source code | no. Code that handles secrets and contains none |

Content patterns searched: AWS keys, Twilio `AC…`/`SK…` SIDs, Google OAuth
client secrets and IDs, Google API keys, PEM private-key blocks outside the
fixtures, Stripe, Slack, GitHub tokens, Postgres URLs with passwords, and
generic `token/secret/password = "<long literal>"`. Also checked: no
Cloudflare `account_id` or API token, and no personal email addresses in any
file.

## File lists

The exact paths, as git reported them before the commit.

These lists were taken before this file existed; it is part of the preservation commit. `docs/PRE_PRODUCTION_BASELINE.md` is recorded in a follow-up commit, since it names the preservation commit and tag.

### Tracked, deleted (4)

```
apps/tenant-web/src/components/LanguageToggle.tsx
apps/tenant-web/src/lib/i18n/en.ts
apps/tenant-web/src/lib/i18n/index.tsx
apps/tenant-web/src/lib/i18n/sq.ts
```

### Tracked, modified (166)

```
.env.example
.env.production.example
.gitignore
README.md
apps/admin-web/index.html
apps/admin-web/package.json
apps/admin-web/src/App.tsx
apps/admin-web/src/components/Layout.tsx
apps/admin-web/src/lib/api.ts
apps/admin-web/src/lib/auth.tsx
apps/admin-web/src/main.tsx
apps/admin-web/src/pages/AuthCallbackPage.tsx
apps/admin-web/src/pages/LoginPage.tsx
apps/admin-web/src/pages/TenantDetailPage.tsx
apps/admin-web/src/pages/TenantsPage.tsx
apps/admin-web/src/styles.css
apps/api/jest.integration.config.js
apps/api/migrations/0001_baseline.js
apps/api/package.json
apps/api/scripts/reset-demo.js
apps/api/scripts/seed-demo.js
apps/api/src/app.module.ts
apps/api/src/bootstrap.ts
apps/api/src/core/audit/clinic-audit.module.ts
apps/api/src/core/audit/clinic-audit.service.ts
apps/api/src/core/authz/route-coverage.spec.ts
apps/api/src/core/config/env.validation.spec.ts
apps/api/src/core/config/env.validation.ts
apps/api/src/core/oauth/oauth.controller.ts
apps/api/src/core/storage/storage.service.ts
apps/api/src/core/tenancy/tenant-routes.ts
apps/api/src/modules/clinic/analytics/analytics.service.ts
apps/api/src/modules/clinic/appointments/appointments.service.ts
apps/api/src/modules/clinic/auth/auth.controller.ts
apps/api/src/modules/clinic/auth/auth.service.ts
apps/api/src/modules/clinic/auth/dto/login.dto.ts
apps/api/src/modules/clinic/auth/guards.spec.ts
apps/api/src/modules/clinic/auth/jwt.guard.ts
apps/api/src/modules/clinic/billing/billing.module.ts
apps/api/src/modules/clinic/billing/billing.service.ts
apps/api/src/modules/clinic/billing/patient-ledger.controller.ts
apps/api/src/modules/clinic/charting/chart.controller.ts
apps/api/src/modules/clinic/charting/charting.service.ts
apps/api/src/modules/clinic/charting/dto/charting.dto.ts
apps/api/src/modules/clinic/charting/patient-procedures.controller.ts
apps/api/src/modules/clinic/charting/procedures.controller.ts
apps/api/src/modules/clinic/charting/tooth-conditions.controller.ts
apps/api/src/modules/clinic/documents/documents.controller.ts
apps/api/src/modules/clinic/documents/documents.module.ts
apps/api/src/modules/clinic/documents/documents.service.ts
apps/api/src/modules/clinic/documents/dto/documents.dto.ts
apps/api/src/modules/clinic/documents/patient-documents.controller.ts
apps/api/src/modules/clinic/finance/billing-engine.ts
apps/api/src/modules/clinic/finance/dto/finance.dto.ts
apps/api/src/modules/clinic/finance/finance.module.ts
apps/api/src/modules/clinic/finance/finance.service.ts
apps/api/src/modules/clinic/finance/invoices.controller.ts
apps/api/src/modules/clinic/finance/payments.controller.ts
apps/api/src/modules/clinic/patient-history/allergies.controller.ts
apps/api/src/modules/clinic/patient-history/conditions.controller.ts
apps/api/src/modules/clinic/patient-history/medications.controller.ts
apps/api/src/modules/clinic/patient-history/patient-history.controller.ts
apps/api/src/modules/clinic/patient-history/patient-history.service.ts
apps/api/src/modules/clinic/patients/dto/patient.dto.ts
apps/api/src/modules/clinic/patients/patients.controller.ts
apps/api/src/modules/clinic/patients/patients.module.ts
apps/api/src/modules/clinic/patients/patients.service.ts
apps/api/src/modules/clinic/perio/patient-perio.controller.ts
apps/api/src/modules/clinic/perio/perio-exams.controller.ts
apps/api/src/modules/clinic/perio/perio.service.ts
apps/api/src/modules/clinic/reminders/channels/channels.ts
apps/api/src/modules/clinic/reminders/dto/reminders.dto.ts
apps/api/src/modules/clinic/reminders/reminder-scheduler.service.ts
apps/api/src/modules/clinic/reminders/reminders.controller.ts
apps/api/src/modules/clinic/reminders/reminders.module.ts
apps/api/src/modules/clinic/reminders/reminders.service.ts
apps/api/src/modules/clinic/reports/reports.controller.ts
apps/api/src/modules/clinic/reports/reports.service.ts
apps/api/src/modules/clinic/settings/dto/settings.dto.ts
apps/api/src/modules/clinic/settings/settings.controller.ts
apps/api/src/modules/clinic/settings/settings.module.ts
apps/api/src/modules/clinic/settings/settings.service.ts
apps/api/src/modules/clinic/staff/dto/staff.dto.ts
apps/api/src/modules/clinic/staff/staff.controller.ts
apps/api/src/modules/clinic/staff/staff.service.ts
apps/api/src/modules/clinic/treatment-plans/cost-engine.ts
apps/api/src/modules/clinic/treatment-plans/patient-plans.controller.ts
apps/api/src/modules/clinic/treatment-plans/plan-items.controller.ts
apps/api/src/modules/clinic/treatment-plans/treatment-plans.controller.ts
apps/api/src/modules/clinic/treatments/dto/treatments.dto.ts
apps/api/src/modules/clinic/treatments/treatments.service.ts
apps/api/src/modules/platform/auth/platform-auth.controller.ts
apps/api/src/modules/platform/auth/platform-auth.service.ts
apps/api/src/modules/platform/plans/plans.controller.ts
apps/api/src/modules/platform/plans/plans.module.ts
apps/api/src/modules/platform/tenants/dto/tenant.dto.ts
apps/api/src/modules/platform/tenants/tenants.controller.ts
apps/api/src/modules/platform/tenants/tenants.service.ts
apps/api/src/shared/types/access-token.ts
apps/api/test/integration/api-auth.itest.ts
apps/api/test/integration/api.ts
apps/api/test/integration/db.ts
apps/api/test/integration/fixtures.ts
apps/api/test/integration/privileges.itest.ts
apps/api/test/integration/spa-parity.itest.ts
apps/api/test/integration/tenant-isolation.itest.ts
apps/api/test/integration/tenant-middleware.itest.ts
apps/api/worker/app-bundle.d.ts
apps/api/worker/app-entry.cjs
apps/api/worker/index.ts
apps/api/wrangler.jsonc
apps/tenant-web/index.html
apps/tenant-web/package.json
apps/tenant-web/public/_headers
apps/tenant-web/src/App.tsx
apps/tenant-web/src/components/AppLayout.tsx
apps/tenant-web/src/components/AppointmentModal.tsx
apps/tenant-web/src/components/DentalChartCard.tsx
apps/tenant-web/src/components/DocumentsCard.tsx
apps/tenant-web/src/components/GoogleButton.tsx
apps/tenant-web/src/components/MedicalHistoryCard.tsx
apps/tenant-web/src/components/Odontogram.tsx
apps/tenant-web/src/components/PatientLedgerCard.tsx
apps/tenant-web/src/components/PerioChartCard.tsx
apps/tenant-web/src/components/RevenueChart.tsx
apps/tenant-web/src/components/TreatmentPlanCard.tsx
apps/tenant-web/src/components/VoidModal.tsx
apps/tenant-web/src/components/ui.tsx
apps/tenant-web/src/lib/api.ts
apps/tenant-web/src/lib/auth.tsx
apps/tenant-web/src/lib/format.ts
apps/tenant-web/src/lib/permissions.ts
apps/tenant-web/src/lib/tooth-notation.ts
apps/tenant-web/src/main.tsx
apps/tenant-web/src/pages/ActivityPage.tsx
apps/tenant-web/src/pages/AuthCallbackPage.tsx
apps/tenant-web/src/pages/DashboardPage.tsx
apps/tenant-web/src/pages/ExpensesPage.tsx
apps/tenant-web/src/pages/FinancialsPage.tsx
apps/tenant-web/src/pages/InvoiceDetailPage.tsx
apps/tenant-web/src/pages/InvoicesPage.tsx
apps/tenant-web/src/pages/LoginPage.tsx
apps/tenant-web/src/pages/PatientFormPage.tsx
apps/tenant-web/src/pages/PatientProfilePage.tsx
apps/tenant-web/src/pages/PatientsListPage.tsx
apps/tenant-web/src/pages/ReportsPage.tsx
apps/tenant-web/src/pages/ReservationsPage.tsx
apps/tenant-web/src/pages/SettingsPage.tsx
apps/tenant-web/src/pages/StaffPage.tsx
apps/tenant-web/src/pages/TreatmentsPage.tsx
apps/tenant-web/src/styles.css
docs/ARCHITECTURE.md
docs/CHANGELOG.md
docs/DEPLOYMENT.md
docs/PROJECT_STRUCTURE.md
docs/RELEASE_CHECKLIST.md
docs/SECURITY_AUDIT.md
eslint.config.js
package-lock.json
package.json
packages/shared/src/api-types.ts
packages/shared/src/index.ts
packages/shared/src/permissions.spec.ts
packages/shared/src/permissions.ts
scripts/build-baseline.js
scripts/dev-setup.js
```

### Untracked (214)

```
apps/admin-web/src/components/CommandPalette.tsx
apps/admin-web/src/components/CreateClinicWizard.tsx
apps/admin-web/src/components/PaymentModal.tsx
apps/admin-web/src/components/TwoStep.tsx
apps/admin-web/src/components/charts.tsx
apps/admin-web/src/components/shell.tsx
apps/admin-web/src/components/ui.tsx
apps/admin-web/src/lib/activity.ts
apps/admin-web/src/lib/format.ts
apps/admin-web/src/operations.css
apps/admin-web/src/pages/ActivityPage.tsx
apps/admin-web/src/pages/BillingPage.tsx
apps/admin-web/src/pages/OverviewPage.tsx
apps/admin-web/src/pages/PlansPage.tsx
apps/admin-web/src/pages/UsagePage.tsx
apps/api/migrations/0002_inventory.js
apps/api/migrations/0003_clinical-roles.js
apps/api/migrations/0004_clinical-record-integrity.js
apps/api/migrations/0005_sessions-and-mfa.js
apps/api/migrations/0006_money-minor-units.js
apps/api/migrations/0007_inventory-lots.js
apps/api/migrations/0008_reminder-delivery.js
apps/api/migrations/0009_clinic-operations.js
apps/api/migrations/0010_fiscalization.js
apps/api/migrations/0011_platform-lifecycle.js
apps/api/migrations/0012_albanian-market.js
apps/api/migrations/0013_foundations.js
apps/api/migrations/0014_cash_drawer.js
apps/api/migrations/0015_checkout_documents.js
apps/api/migrations/0016_platform_billing.js
apps/api/scripts/check-cloudflare-bindings.mjs
apps/api/scripts/check-hyperdrive-caching.mjs
apps/api/scripts/set-hyperdrive-ids.mjs
apps/api/src/bootstrap.spec.ts
apps/api/src/core/audit/clinical-record.ts
apps/api/src/core/audit/patient-access.ts
apps/api/src/core/config/env.validation.sms.spec.ts
apps/api/src/core/entitlements/entitlements.service.ts
apps/api/src/core/idempotency/idempotency.interceptor.ts
apps/api/src/core/mfa/mfa.module.ts
apps/api/src/core/mfa/mfa.service.ts
apps/api/src/core/mfa/recovery-codes.ts
apps/api/src/core/mfa/secret-box.spec.ts
apps/api/src/core/mfa/secret-box.ts
apps/api/src/core/mfa/totp.spec.ts
apps/api/src/core/mfa/totp.ts
apps/api/src/core/money/clinic-currency.ts
apps/api/src/core/money/invoice-number.ts
apps/api/src/core/pdf/pdf-writer.spec.ts
apps/api/src/core/pdf/pdf-writer.ts
apps/api/src/core/request-context/request-context.ts
apps/api/src/core/sessions/session-store.ts
apps/api/src/core/sessions/session-tokens.spec.ts
apps/api/src/core/sessions/session-tokens.ts
apps/api/src/modules/clinic/billing/estimate.service.ts
apps/api/src/modules/clinic/billing/fx-rates.service.spec.ts
apps/api/src/modules/clinic/billing/fx-rates.service.ts
apps/api/src/modules/clinic/billing/plan-estimate.controller.ts
apps/api/src/modules/clinic/cash-drawer/cash-drawer.controller.ts
apps/api/src/modules/clinic/cash-drawer/cash-drawer.module.ts
apps/api/src/modules/clinic/cash-drawer/cash-drawer.service.ts
apps/api/src/modules/clinic/cash-drawer/drawer-ledger.spec.ts
apps/api/src/modules/clinic/cash-drawer/drawer-ledger.ts
apps/api/src/modules/clinic/cash-drawer/dto/cash-drawer.dto.ts
apps/api/src/modules/clinic/cash-drawer/index.ts
apps/api/src/modules/clinic/documents/documents.service.spec.ts
apps/api/src/modules/clinic/features/dto/features.dto.ts
apps/api/src/modules/clinic/features/features.controller.ts
apps/api/src/modules/clinic/features/features.module.ts
apps/api/src/modules/clinic/features/features.service.ts
apps/api/src/modules/clinic/features/index.ts
apps/api/src/modules/clinic/finance/invoice-pdf.service.ts
apps/api/src/modules/clinic/finance/invoice-pdf.spec.ts
apps/api/src/modules/clinic/finance/invoice-pdf.ts
apps/api/src/modules/clinic/fiscalization/__fixtures__/other-cert.pem
apps/api/src/modules/clinic/fiscalization/__fixtures__/other-key.pem
apps/api/src/modules/clinic/fiscalization/__fixtures__/test-3des.p12
apps/api/src/modules/clinic/fiscalization/__fixtures__/test-cert.pem
apps/api/src/modules/clinic/fiscalization/__fixtures__/test-key-pkcs1.pem
apps/api/src/modules/clinic/fiscalization/__fixtures__/test-key.pem
apps/api/src/modules/clinic/fiscalization/__fixtures__/test-legacy.p12
apps/api/src/modules/clinic/fiscalization/__fixtures__/test-modern.p12
apps/api/src/modules/clinic/fiscalization/__fixtures__/test-pbes2-3des.p12
apps/api/src/modules/clinic/fiscalization/dto/fiscal.dto.ts
apps/api/src/modules/clinic/fiscalization/fiscal-crypto.spec.ts
apps/api/src/modules/clinic/fiscalization/fiscal-crypto.ts
apps/api/src/modules/clinic/fiscalization/fiscal-pkcs12.spec.ts
apps/api/src/modules/clinic/fiscalization/fiscal-pkcs12.ts
apps/api/src/modules/clinic/fiscalization/fiscal-queue.spec.ts
apps/api/src/modules/clinic/fiscalization/fiscal-queue.ts
apps/api/src/modules/clinic/fiscalization/fiscal-scheduler.service.ts
apps/api/src/modules/clinic/fiscalization/fiscal-xml.spec.ts
apps/api/src/modules/clinic/fiscalization/fiscal-xml.ts
apps/api/src/modules/clinic/fiscalization/fiscal.controller.ts
apps/api/src/modules/clinic/fiscalization/fiscal.service.ts
apps/api/src/modules/clinic/fiscalization/fiscalization.module.ts
apps/api/src/modules/clinic/fiscalization/legacy-ciphers.spec.ts
apps/api/src/modules/clinic/fiscalization/legacy-ciphers.ts
apps/api/src/modules/clinic/inventory/dto/inventory.dto.ts
apps/api/src/modules/clinic/inventory/index.ts
apps/api/src/modules/clinic/inventory/inventory.controller.ts
apps/api/src/modules/clinic/inventory/inventory.module.ts
apps/api/src/modules/clinic/inventory/inventory.service.ts
apps/api/src/modules/clinic/inventory/item-movements.controller.ts
apps/api/src/modules/clinic/inventory/lot-engine.spec.ts
apps/api/src/modules/clinic/inventory/lot-engine.ts
apps/api/src/modules/clinic/inventory/stock-engine.spec.ts
apps/api/src/modules/clinic/inventory/stock-engine.ts
apps/api/src/modules/clinic/patients/dto/patient-import.dto.ts
apps/api/src/modules/clinic/patients/patient-import.controller.ts
apps/api/src/modules/clinic/patients/patient-import.service.ts
apps/api/src/modules/clinic/reminders/channels/registry.ts
apps/api/src/modules/clinic/reminders/channels/twilio.spec.ts
apps/api/src/modules/clinic/reminders/channels/twilio.ts
apps/api/src/modules/clinic/reminders/channels/viber.ts
apps/api/src/modules/clinic/reminders/channels/whatsapp.spec.ts
apps/api/src/modules/clinic/reminders/channels/whatsapp.ts
apps/api/src/modules/clinic/reminders/delivery-policy.spec.ts
apps/api/src/modules/clinic/reminders/delivery-policy.ts
apps/api/src/modules/clinic/reminders/dto/messages.dto.ts
apps/api/src/modules/clinic/reminders/messages.controller.ts
apps/api/src/modules/clinic/reminders/messages.service.ts
apps/api/src/modules/clinic/reminders/reminder-delivery.controller.ts
apps/api/src/modules/clinic/settings/closures.controller.ts
apps/api/src/modules/clinic/settings/closures.service.ts
apps/api/src/modules/clinic/settings/dto/closures.dto.ts
apps/api/src/modules/platform/activity/activity.controller.ts
apps/api/src/modules/platform/activity/activity.module.ts
apps/api/src/modules/platform/activity/activity.service.ts
apps/api/src/modules/platform/activity/index.ts
apps/api/src/modules/platform/billing/billing.controller.ts
apps/api/src/modules/platform/billing/billing.module.ts
apps/api/src/modules/platform/billing/billing.service.ts
apps/api/src/modules/platform/billing/dto/billing.dto.ts
apps/api/src/modules/platform/billing/index.ts
apps/api/src/modules/platform/plans/dto/plan.dto.ts
apps/api/src/modules/platform/plans/plans.service.ts
apps/api/src/modules/platform/usage/index.ts
apps/api/src/modules/platform/usage/usage.controller.ts
apps/api/src/modules/platform/usage/usage.module.ts
apps/api/src/modules/platform/usage/usage.service.ts
apps/api/src/shared/dto/auth.dto.ts
apps/api/src/shared/dto/entered-in-error.dto.ts
apps/api/test/integration/albanian-market.itest.ts
apps/api/test/integration/api-clinical.itest.ts
apps/api/test/integration/api-inventory-lots.itest.ts
apps/api/test/integration/api-inventory.itest.ts
apps/api/test/integration/api-mfa.itest.ts
apps/api/test/integration/api-sessions.itest.ts
apps/api/test/integration/cash-drawer.itest.ts
apps/api/test/integration/checkout.itest.ts
apps/api/test/integration/clinical-record.itest.ts
apps/api/test/integration/env.setup.js
apps/api/test/integration/inventory.itest.ts
apps/api/test/integration/money.itest.ts
apps/api/test/integration/platform-billing.itest.ts
apps/api/test/integration/platform-console.itest.ts
apps/api/test/integration/reminders-delivery.itest.ts
apps/tenant-web/src/components/AccountSecurityModal.tsx
apps/tenant-web/src/components/ArchView.tsx
apps/tenant-web/src/components/CameraCaptureModal.tsx
apps/tenant-web/src/components/MoneyInput.tsx
apps/tenant-web/src/components/PhotoCropModal.tsx
apps/tenant-web/src/components/QrCode.tsx
apps/tenant-web/src/components/ServicePicker.tsx
apps/tenant-web/src/components/TwoStepSetup.tsx
apps/tenant-web/src/components/drawer/ApprovalFields.tsx
apps/tenant-web/src/components/drawer/CloseDrawerPanel.tsx
apps/tenant-web/src/components/drawer/CountGrid.tsx
apps/tenant-web/src/components/drawer/DrawerChip.tsx
apps/tenant-web/src/components/drawer/SessionDetailPanel.tsx
apps/tenant-web/src/components/drawer/drawer-text.ts
apps/tenant-web/src/components/settings/BrandingCard.tsx
apps/tenant-web/src/components/settings/CashDrawerCard.tsx
apps/tenant-web/src/components/settings/ClosuresCard.tsx
apps/tenant-web/src/components/settings/FeaturesCard.tsx
apps/tenant-web/src/components/settings/FinanceCard.tsx
apps/tenant-web/src/components/settings/FiscalCard.tsx
apps/tenant-web/src/drawer.css
apps/tenant-web/src/lib/features.tsx
apps/tenant-web/src/lib/image.ts
apps/tenant-web/src/lib/reminders.ts
apps/tenant-web/src/lib/strings.ts
apps/tenant-web/src/lib/useMinute.ts
apps/tenant-web/src/lib/vat.ts
apps/tenant-web/src/messaging.css
apps/tenant-web/src/operations.css
apps/tenant-web/src/pages/CashDrawerPage.tsx
apps/tenant-web/src/pages/EstimatePage.tsx
apps/tenant-web/src/pages/FiscalQueuePage.tsx
apps/tenant-web/src/pages/FiscalReceiptPage.tsx
apps/tenant-web/src/pages/InventoryPage.tsx
apps/tenant-web/src/pages/MessagesPage.tsx
apps/tenant-web/src/pages/PatientImportPage.tsx
apps/tenant-web/src/print.css
docs/CLAUDE_AUDIT.md
docs/CLAUDE_EXECUTION_PLAN.md
packages/shared/src/cash-drawer.spec.ts
packages/shared/src/cash-drawer.ts
packages/shared/src/csv.spec.ts
packages/shared/src/csv.ts
packages/shared/src/features.spec.ts
packages/shared/src/features.ts
packages/shared/src/messages.spec.ts
packages/shared/src/messages.ts
packages/shared/src/money.spec.ts
packages/shared/src/money.ts
packages/shared/src/patient-import.spec.ts
packages/shared/src/patient-import.ts
packages/shared/src/reminders.spec.ts
packages/shared/src/reminders.ts
packages/shared/src/vat.spec.ts
packages/shared/src/vat.ts
scripts/audit-classes.js
```
