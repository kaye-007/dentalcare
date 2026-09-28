# DentalCare — demo accounts

Updated 2026-09-27 · Seeded by `apps/api/scripts/seed-demo.js`

**Everything here is fictional demo data.** The people, phone numbers, addresses, patients and prices were made up for the demo. None of it describes a real person or clinic.

These accounts exist only in a database loaded with the demo seed. Nothing in production creates them.

## The demo clinic

|                      |                                                                                   |
| -------------------- | --------------------------------------------------------------------------------- |
| Clinic               | **DEMO**                                                                          |
| Subdomain            | `demo` (on localhost, set `DEV_TENANT_SUBDOMAIN=demo`)                            |
| Currency · time zone | Albanian lek (ALL) · Europe/Tirane                                                |
| Plan                 | Professional, on a 30-day trial that restarts with every demo reset               |
| Rooms                | Salla 1, Salla 2, Salla 3                                                         |
| Hours                | Mon–Fri 09:00–18:00. Sat and Sun 09:00–14:00, so a demo on any day has a "today". |

## Language

The app's interface is English. The clinic's own data is Albanian: service names and price list, rooms, staff positions, visit reasons, treatment plans, clinical notes, chart notes, allergies, stock items and categories, expenses, payment notes and reminder texts. Patient names, streets and cities were already Albanian.

## Sign-in

Every account below uses the password **`Demo@2026!`**.

This password is published in the repository. `dev-setup` and `bootstrap-admin` refuse it for any real account, so it can only ever unlock demo data.

### Clinic app

| Person             | Email                  | Role                  | Position                  | Room    |
| ------------------ | ---------------------- | --------------------- | ------------------------- | ------- |
| Dr. Erion Hoxha    | `demo@dentx.app`       | Administrator (owner) | Pronar i klinikës         | —       |
| Dr. Ardit Hoxha    | `a.hoxha@dentx.app`    | Dentist               | Stomatolog i përgjithshëm | Salla 1 |
| Dr. Elira Dervishi | `e.dervishi@dentx.app` | Dentist               | Endodontiste              | Salla 2 |
| Dr. Besnik Kola    | `b.kola@dentx.app`     | Dentist               | Kirurg oral               | Salla 3 |
| Ana Kola           | `reception@dentx.app`  | Receptionist          | Recepsioniste             | —       |

### Platform console (Control Center)

| Person                 | Email             | Role           |
| ---------------------- | ----------------- | -------------- |
| Platform Administrator | `admin@dentx.app` | Platform admin |

The console lists exactly one clinic, the demo clinic. It shows the clinic's status, plan, trial and staff, plus aggregate counts such as the number of patients. It shows no clinical records.

## What to show with which account

| Account                | Start here                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reception@dentx.app`  | **Home**: today's list, Check in, Call. **Bill** on Jona Meta's row: her two fillings are already on the invoice. The **cash drawer** is open with a 20,000 L float. **Patients › Recall** lists 24 patients due for a check-up. |
| `b.kola@dentx.app`     | **Clinical**: today's patients, including **Arben Hoxha**'s implant review at 12:30 (his chart and plan).                                                                                                                        |
| `e.dervishi@dentx.app` | **Erisa Kola**'s second root-canal session today. She has a penicillin allergy and a crown plan proposed.                                                                                                                        |
| `demo@dentx.app`       | **Dashboard**, **Reports** and **Settings**. The owner sees everything.                                                                                                                                                          |
| `admin@dentx.app`      | The Control Center, at `:5174`.                                                                                                                                                                                                  |

### Walkthrough patients

| Patient         | The story                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arben Hoxha     | Implant 36 with Dr. Kola. The plan is in progress: implant done and paid, abutment booked, crown planned. His chart shows older fillings, a root-treated crowned 16 and caries on 14 and 47. |
| Gentian Meta    | Two zirconia crowns (14, 15). **Invoice 50,000 L, paid 30,000 L, outstanding 20,000 L.** Latex allergy. Review booked.                                                                       |
| Erisa Kola      | Root canal 46: session 1 last week, session 2 today. Penicillin allergy. Crown plan proposed.                                                                                                |
| Klajdi Dervishi | New patient, registered today; consultation this afternoon.                                                                                                                                  |
| Elona Leka      | Cleaning, then whitening. Fully settled.                                                                                                                                                     |
| Sara Hoxha      | A child's check-up and cleaning.                                                                                                                                                             |
| Andi Kola       | Missed last week's filling (no-show); rebooked for tomorrow.                                                                                                                                 |
| Bora Dervishi   | Consultation, then a cancelled follow-up. A four-veneer plan is proposed with 10% off.                                                                                                       |
| Ermal Leka      | Surgical extraction of 38 yesterday; suture removal next week.                                                                                                                               |
| Jona Meta       | Two composite fillings first thing today, charted by Dr. Hoxha and **not billed yet**. **Bill** turns the chart into the invoice.                                                            |

About 290 more patients fill the calendar and the patient list. 24 of them were last in six to eleven months ago with nothing booked, so the Recall list has people to call. Their names are generated from common Albanian first names and surnames. Phone numbers are random, emails are `@example.com` (reserved, can never deliver), and no patient has WhatsApp consent. Reminders go to the log channel only.

## Resetting the demo

```bash
DEMO_ENV=true npm run demo:reset
```

PowerShell:

```powershell
$env:DEMO_ENV='true'; npm run demo:reset
```

The reset **removes every clinic in `DATABASE_URL`** (it lists them first) and then loads the demo clinic. Run it only against a database that exists for demos. It refuses to run:

- unless `DEMO_ENV=true` is set (exactly `true`);
- when `NODE_ENV=production` or `RUNTIME=workers`;
- against a host that is not local, unless `ALLOW_REMOTE_RESET=yes` / `ALLOW_REMOTE_SEED=yes` is also set;
- against a database whose name or host contains "prod";
- against a schema that is behind the migrations.

The seed is deterministic, so every reset builds the same clinic, moved to the new "today".
