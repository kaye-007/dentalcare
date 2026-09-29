# Privacy and retention — technical checklist

Date: 2026-09-28 · Owner's decision 6 in [SECURITY_PROGRAM.md](./SECURITY_PROGRAM.md#4-decisions-taken-2026-09-28)

> **LEGAL REVIEW REQUIRED — this is not a policy and not legal advice.**
> This document describes what the software stores, where, for how long, and what it can and cannot do today. It does not say how long anything _must_ or _may_ be kept. Those periods, the legal bases and the duties they imply must come from an **Albanian legal and privacy review** of Albania's data-protection and health-record rules. No retention period in this repository is a legal determination, and **nothing here claims that DentalCare, NODE X or any clinic complies with any law.**

The clinic decides why and how its patients' data is processed. NODE X runs the software that processes it. The review has to confirm those roles (§5).

---

## 1. What personal data the software holds

Tables are PostgreSQL tables. "RLS" means the clinic's row security applies: 61 of the 71 tables force it, so one clinic's session can never read another clinic's rows.

| Category             | Where                                                                                                                                                   | Whose             | Notes                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| Identity and contact | `patients` (RLS)                                                                                                                                        | patients          | name, birth date, phone, email, address, photo reference                                         |
| Medical history      | `patient_allergies`, `patient_conditions`, `patient_medications`, `patient_notes` (RLS)                                                                 | patients          | health data; the safeguards it needs are question 5 of the review (§5)                           |
| Clinical record      | `tooth_conditions`, `clinical_procedures`, `perio_exams`, `perio_measurements`, `perio_tooth_findings`, `treatment_plans`, `treatment_plan_items` (RLS) | patients          | health data; signed entries are locked                                                           |
| Documents and images | `patient_documents` (RLS) + object storage (S3/R2 bucket, or the container's disk)                                                                      | patients          | X-rays, OPG/CBCT, consent forms, photos                                                          |
| Appointments         | `appointments`, `appointment_status_events` (RLS)                                                                                                       | patients, staff   | visit reasons can reveal health information                                                      |
| Money                | `invoices`, `invoice_line_items`, `payments`, `ledger_entries` (RLS)                                                                                    | patients          | line items name treatments                                                                       |
| Fiscal records       | `fiscal_invoices`, `fiscal_cash_deposits` (RLS)                                                                                                         | patients, clinic  | what was sent to the tax authority                                                               |
| Messages             | `reminders`, `whatsapp_message_sends`, `whatsapp_send_batches` (RLS)                                                                                    | patients          | phone number and message text                                                                    |
| Messaging consent    | `patients.reminders_opt_out` (+ `_at`, `_source`), `patients.whatsapp_opt_in` (+ `_at`, `_source`)                                                      | patients          | when and how a patient opted in or out                                                           |
| Lab work             | `lab_orders` (RLS)                                                                                                                                      | patients          | names the patient and the treatment                                                              |
| Access trail         | `patient_access_log` (RLS)                                                                                                                              | staff, patients   | who opened which record                                                                          |
| Activity trail       | `clinic_audit_log` (RLS), `audit_log` (console)                                                                                                         | staff             | actions, with request id, IP address and user agent                                              |
| Staff accounts       | `users`, `user_sessions`, `user_mfa_factors`, `user_mfa_recovery_codes` (RLS)                                                                           | staff             | passwords and PINs as bcrypt, refresh tokens as SHA-256, second factors sealed with AES-256-GCM  |
| Wages                | `salary_payments` (RLS)                                                                                                                                 | staff             | no longer shown in the app; the rows remain                                                      |
| Console accounts     | `platform_admins`, `platform_sessions`, `platform_mfa_*`                                                                                                | NODE X staff      |                                                                                                  |
| Sign-in counters     | `auth_throttle`                                                                                                                                         | anyone signing in | keys are HMACs; the table holds no email and no IP                                               |
| Replay store         | `idempotency_keys` (RLS), `platform_idempotency_keys`                                                                                                   | patients, staff   | a hash of each money request, and its **response** for 24 hours, which can include patient names |
| Import batches       | `patient_imports` (RLS)                                                                                                                                 | —                 | file name and counts only; the rows imported are not kept here                                   |

Outside the database:

- **Backups** made by `npm run db:backup` hold every clinic's records. They are ignored by git (`backups/`) and kept wherever the operator puts them. The provider's own backups are not configured yet.
- **Logs.** The application log carries no patient data by design ([DEPLOYMENT.md](./DEPLOYMENT.md#health-logging-observability)). How long the platform keeps logs is set by the Cloudflare plan or the container's log sink; nothing in the repository sets it.
- **Clinic exports** from the console (`exportSnapshot`, capped at 200,000 rows) are downloaded files. Once downloaded they are outside the system.

## 2. What happens to data today

| Data                                | Behaviour today                                                                                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A patient                           | **Archived, never deleted** (`status = 'archived'`, `archived_at`, `archive_reason`). An archived patient can be restored. No path erases one.                                          |
| The clinical record                 | **Never deleted by anyone.** The runtime role holds no DELETE on clinical tables (0004). A wrong entry is withdrawn as entered in error, with a reason, and stays visible as withdrawn. |
| Payments                            | Never deleted: 0018 revoked DELETE. A mistake is voided, and the void is permanent.                                                                                                     |
| A patient document                  | **Soft-deleted** (`deleted_at`, `deleted_by`). The row's metadata stays (file name, kind, patient). **The stored file itself is removed** from the bucket or disk.                      |
| A clinic                            | Soft-deleted on the console (`status = 'deleted'`). **All of its data remains** in the database.                                                                                        |
| Expired sessions                    | Deleted one day after expiry, when the same person next signs in.                                                                                                                       |
| Sign-in counters                    | Deleted a day after their window or lock ends.                                                                                                                                          |
| Replay store                        | Replayed for 24 hours, then swept on a random 2% of later requests. There is no fixed purge job.                                                                                        |
| Activity and access trails          | Kept indefinitely. Nothing prunes them.                                                                                                                                                 |
| Messages, reminders, fiscal records | Kept indefinitely.                                                                                                                                                                      |
| Backups                             | Whatever the operator or provider keeps; no retention is set.                                                                                                                           |

## 3. What a patient or clinic can ask for, and what the software can do

| Request                         | Today                                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| See their data (access)         | Staff can view and print parts of the record. **No per-patient export** exists to hand a patient their data in one file.                                                                                                                                     |
| Correct it                      | Demographics are edited. Clinical entries are corrected by withdrawal plus a new entry, never by silent edit.                                                                                                                                                |
| Erase it                        | **Not possible.** Archive only. Whether and when erasure is lawful for health and fiscal records is for the legal review.                                                                                                                                    |
| Take it elsewhere (portability) | Only the clinic-wide export from the console. No per-patient, machine-readable export.                                                                                                                                                                       |
| Stop messages                   | Reminder opt-out and WhatsApp opt-in are recorded with their time and source. SMS reminders skip an opted-out patient (tested in `reminders-delivery.itest.ts`). The WhatsApp reminder list reads both flags; no test yet proves a WhatsApp send is skipped. |
| Leave, as a clinic              | Clinic export (JSON, with a SHA-256), then soft delete. The data stays in the database until someone removes it by hand.                                                                                                                                     |

## 4. Where data goes outside the database

| Recipient                                | What it receives                                        | When                                         |
| ---------------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| Cloudflare (Workers, Hyperdrive, logs)   | every request and response in transit; application logs | always, on the Workers deployment            |
| Database host (not chosen yet)           | everything                                              | always                                       |
| Object storage (S3 or R2, if configured) | patient documents and images                            | on upload                                    |
| Twilio                                   | patient phone number and reminder text                  | when a clinic sends SMS                      |
| Meta (WhatsApp Cloud API)                | patient phone number and template text                  | when a clinic sends WhatsApp                 |
| Vonage (Viber)                           | patient phone number and message text                   | when a clinic sends Viber                    |
| Google                                   | the staff member's Google identity                      | when staff sign in with Google               |
| The Albanian tax authority (CIS)         | the fiscal invoice data the fiscalization rules require | on every fiscal invoice and cash declaration |
| Exchange-rate provider                   | nothing personal                                        | daily rates                                  |

Several of these recipients process data outside Albania, and some outside Europe.

## 5. For the legal and privacy review — questions the software cannot answer

**None of these has an answer in this repository.** Each one is open until counsel answers it.

1. **Roles.** Is each clinic the controller and NODE X its processor? What must the agreement between them say, and which of the recipients in §4 are sub-processors?
2. **Retention periods**, and whether each is a minimum, a maximum or both:
   - the dental and clinical record;
   - patient documents and images;
   - invoices, payments and fiscal records;
   - the activity and access trails;
   - messages and reminders;
   - backups;
   - logs;
   - a deleted clinic's data.
3. **Erasure.** When the law allows or requires erasing health or financial data, what must happen to it in backups?
4. **Legal basis** for each purpose: treatment, billing and fiscalization, appointment reminders, WhatsApp messages. Is the recorded opt-in enough where consent is the basis?
5. **Health data.** What conditions and safeguards apply to processing health data? Are those in [SECURITY_PROGRAM.md](./SECURITY_PROGRAM.md) enough, or do more apply?
6. **Minors:** consent and a guardian's rights.
7. **Transfers abroad:** Cloudflare, Twilio, Meta, Vonage and Google (§4).
8. **Registration or notification** with Albania's data-protection authority, and whether a data protection officer is required.
9. **Breach notification:** who notifies whom, and how fast. The monitoring in [MONITORING.md](./MONITORING.md) should detect what this needs.
10. **Patients' rights:** how access, correction and portability requests must be answered, and in what time.

## 6. Technical work that will follow the review

Nothing below is built. Each item waits on the answer that decides its shape.

- [ ] A retention job per category, once periods exist (§5.2). The current behaviour (§2) is "keep", with no exceptions.
- [ ] A per-patient export for access and portability requests (§3).
- [ ] An erasure or anonymisation path, if the review says one is lawful, including what happens to backups.
- [ ] A scheduled purge of `idempotency_keys` and `platform_idempotency_keys`, so the 24-hour window is a guarantee rather than a probability.
- [ ] A decision on removing a deleted clinic's data after the export, and how long after.
- [ ] Log retention set explicitly on the chosen platform and log sink.
- [ ] A sub-processor list published to clinics (§4, §5.1).
- [ ] Backup retention and encryption confirmed with the chosen database provider.
