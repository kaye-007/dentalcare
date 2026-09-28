# DentalCare — product polish: what was done

Date: 2026-09-27 · Follows [PRODUCT_EXPERIENCE_AUDIT.md](./PRODUCT_EXPERIENCE_AUDIT.md) · Branch `preserve/pre-production-sept-9-18`, uncommitted

**The standard.** The basics, done at an exceptional level. This pass did not build a bigger DentalCare.

- The audit found that the two earlier passes had already done most of what the brief asks for: the phone shell, the payment sheet, the drawer, search and role dashboards. What remained were **gaps in the core loop itself**, so that is where this pass went.
- The visual language ("Ink & Ember": glass, bloom, radii, colours) is unchanged, as the owner decided. New styles use the existing tokens and live in `apps/tenant-web/src/polish.css`.
- **No schema migrations.** Every change reuses columns and tables that already exist.

---

## 1. What was improved

### 1.1 Clinical work → invoice, in one step (the core loop)

**Before.** The dentist charts a composite on 36 (`clinical_procedures`: service, tooth, fee). Reception taps **Bill** and gets an empty invoice, then types the same filling again from the service list. Nothing tied that invoice line to the charted work, so the same filling could be billed twice.

**Now:**

- **Bill** opens the new invoice with the dentist's completed, unbilled work already on it. Each line shows its tooth, day and dentist ("From the chart · Tooth 36 · 27 Sept 2026 · Dr. Ardit Hoxha").
- The note above the lines says what happened. The service catalogue folds under _Add another service_, because it is now the exception.
- Reception checks the prices and taps **Create invoice**. The payment sheet opens, and the rest was already one flow.

**How it stays correct:**

- An invoice line can now point at the procedure it bills (`procedureId`, using the existing `invoice_line_items.procedure_id`).
- The server checks that the procedure belongs to this patient, is completed, and is not withdrawn.
- It **locks** the procedure row (`FOR UPDATE`), so two desks cannot bill the same work at once.
- It refuses (409) any procedure already on a live invoice, directly or through its treatment-plan item.
- The tooth is taken from the chart, not from the client. The plan item is linked too, so plan invoicing and visit invoicing can never both bill the same work (the existing unique index enforces it).
- Cancelling the invoice makes the work billable again.

**Legacy data.** Work charted before lines could point at procedures was billed by hand. So an unlinked procedure counts as covered once the patient has a hand-built invoice created after it. That errs towards suggesting too little: a missed suggestion costs one tap in the catalogue, while a wrong one could double-bill. Only the last 30 days are offered.

**Endpoints:**

- `GET /api/invoices/unbilled?patientId=` (`invoices:write`)
- `POST /api/invoices` accepts `procedureId` per line.

### 1.2 Recall: who is due back

**Before.** There was no recall anywhere. The only "recall" in the code was for inventory lots.

**Now:**

- **Patients › Recall** lists active patients whose last completed visit is more than 3, 6 (the default) or 12 months ago, with nothing booked.
- Each row shows the name, the last visit ("27 Feb 2026 · 6 months ago · Pastrim profesional"), **Call** (a `tel:` link) and **Book**, which opens the booking panel with the patient filled in.
- **Booking the patient is what takes them off the list.** Nothing is ticked and nothing is maintained, because the list is derived from appointments. There is no new table.
- Visits older than three years are left out: those patients have moved on.
- The desk and owner dashboards show one quiet line when anyone is due: "24 patients due for a check-up, with nothing booked · Review".
- Endpoint: `GET /api/patients/recall?months=` (`patients:read` + `appointments:read`).

### 1.3 The owner's "today"

**Before.** The owner dashboard showed _This month_, but not today's takings or the drawer.

**Now:**

- One strip above the schedule holds four figures, each a link to its detail:
  - **Appointments** (13 done);
  - **Collected today**;
  - **Still owed** (all open invoices);
  - **Cash drawer**: the expected cash and the number of cash payments, or "Not started", "Counting" or "Needs approval".
- On a phone it is two by two. Tiles the owner's role cannot see are left out, never shown as zero.
- `/finance/summary` gained `period=today`. **Both `today` and `month` are now computed on the clinic's clock** (`clinic_settings.timezone`). Before, the month boundary was the database's UTC midnight, so a payment at 00:30 on the 1st in Tirana counted towards the previous month.

### 1.4 Excel import

**Before.** Import accepted `.csv` only, and the first instruction was "Save the spreadsheet as CSV first".

**Now:**

- **`.xlsx` is read in the browser, with no new dependency.** The browser's own `DecompressionStream` inflates the ZIP and `DOMParser` reads the sheet (`apps/tenant-web/src/lib/xlsx.ts`, about 200 lines).
- It handles:
  - shared strings, including rich-text runs;
  - inline strings;
  - booleans;
  - phones stored as numbers (never shown as `3.5E+11`);
  - cells formatted as dates, which become `DD.MM.YYYY` and read correctly under the default day-month-year order;
  - empty formatted rows, which are dropped.
- The old binary `.xls` gets a clear sentence ("save it as .xlsx").
- **Header matching ignores Albanian diacritics**, so "Datëlindja", "Datelindja" and "DATËLINDJA" all map to _Date of birth_ (with a new unit test).
- The upload screen now says "Drop an Excel or CSV file here", with an example in Albanian (Emri, Mbiemri, Telefoni…).
- Preview, duplicates (in the file and against existing patients) and the import itself are unchanged.

### 1.5 Fiscalization, in three words

| Where                 | Before                                                                  | Now                                                                                 |
| --------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Invoice header pill   | "Fiscal invoice" / "Fiscal · awaiting NIVF" / "Fiscal · not registered" | **Fiscalized** / **Fiscalization pending** / **Fiscalization needs attention**      |
| Fiscal panel          | NIVF, NSLF, business unit, TCR, operator, last error, all open          | Status and one plain sentence; the QR stays; the codes are under **Fiscal details** |
| Payment receipt sheet | "Cash · fiscal invoice"                                                 | "Cash · ✓ Fiscalized" or "Cash · Fiscalization pending"                             |

The plain sentences:

- Pending: "Valid to print now. DentalCare keeps sending it to the tax authority until it is confirmed."
- Refused: "The tax authority refused this invoice. Contact support before issuing it again."

**Fiscal behaviour is untouched.** No request, retry, identifier or document choice changed; only the words and the disclosure did.

### 1.6 Smaller fixes

- **Open invoices on the patient record** are found by patient id (`/invoices?patientId=&status=open`), not by a name search.
  - Before, a namesake's invoices were fetched too, and an older open invoice could fall past the list's newest-200 cap.
  - `status=open` is new: unpaid and partially paid together.
- **Pages reached by address that the role cannot use** now say so: "Not part of your role", or "Not switched on" for a module that is off, with _Back to the dashboard_.
  - Before, a receptionist typing `/financials` saw a page whose every request was refused.
  - This is one guard in the layout, driven by the same navigation map that decides the menu. Every route is covered, including ones added later.
- **Calendar blocks** no longer carry "Scheduled" on every booking. Only the exceptions speak, as the list views already did.
- **Search** offers "See all patients matching …" only when patients matched. Before, it appeared under a lone invoice result.
- **Dates in the clinic's zone:** the patient list's _Registered_ column and the recall dates.

## 2. What was simplified

- **Billing a visit** is **Bill → Create invoice → Take payment**. The catalogue step is gone for charted work.
- **The fiscal panel** is one status, one sentence and one disclosure.
- **The invoice form** puts the lines first when they came from the chart, with the catalogue folded.
- **Recall** has no states to maintain: booking is the only action that matters, and it is the one that clears the row.

## 3. What was intentionally not added

| Not added                                            | Why                                                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drag-to-move on the calendar grid                    | Needs a server move endpoint that returns practitioner and room conflicts before the drop settles. A drag that can silently double-book is worse than the panel. |
| Automated recall / follow-up / confirmation messages | WhatsApp Business needs an approved template per message type per clinic. The recall list with Call and Book works on day one.                                   |
| "Contacted" / "dismissed" states on recall           | They would need a table and create upkeep. Booking clears the row; that is enough to start.                                                                      |
| Treatment "journeys" (implant → healing → crown)     | Treatment plans already sequence multi-visit work. The brief warns against a workflow builder.                                                                   |
| Search across appointments and treatments            | Both are reached through the patient, who is what people search for.                                                                                             |
| A literal "Other" payment method                     | The clinic configures its own methods in Settings; the sheet shows those.                                                                                        |
| Any restyle                                          | Excluded by the owner.                                                                                                                                           |

## 4. By area

**Mobile**

- The Today strip goes two by two.
- Recall rows are 56 px, with Call and Book as 44 px targets.
- The invoice form on a phone leads with the chart's lines.
- **0 horizontal overflow** at 320, 375, 390, 768, 1280 and 1440 px on every changed route (dashboard, recall, import, invoices, the pre-filled form, invoice detail, and the blocked pages).

**Desktop**

- The owner reads the day in one row of figures.
- The invoice form puts the lines where the eye already is.

**Patient**

- Correct open invoices on the record (by id).
- Recall rows link to the record.

**Clinical**

- What the dentist charts is what gets billed. The chart is the source, not a second entry.

**Payments**

- Bill from the chart.
- The receipt sheet states the fiscal result in words.

**Fiscalization UX:** see §1.5.

**Inventory:** no change this pass. It already had status words, Stock in / Stock out and phone cards.

**Demo** (clinic **DEMO**; Albanian data, English UI):

- **Jona Meta**'s two fillings today are charted but **not billed**, so **Bill** shows the flow on any demo.
- **24 patients** were last seen six to eleven months ago, with nothing since, so **Recall** has people to call. Their old visits were paid by card at the time, and the seed still reconciles invoices against the ledger.
- Scripted walkthrough visits on "today" now follow the clock without chance. Before, Erisa Kola's second root-canal session could randomly come out as a no-show.
- `docs/DEMO_ACCOUNTS.md` is updated.

**Performance**

- The record's open-invoice lookup and the dashboard no longer pull a 200-row name search to filter on the client.
- The xlsx reader is in the Import chunk only.
- The main chunk went from 327 kB to 332 kB (104.7 kB gzip). That is the Today strip and the route guard.

**Accessibility**

- **axe-core WCAG 2 A/AA: 0 violations**. It was run as the owner at 1280 px (dashboard, recall, import, invoices, the pre-filled invoice, invoice detail, patient record) and as reception at 390 px (dashboard, recall, a blocked page, the pre-filled invoice).
- New controls are real links and buttons with names ("Call Era Malaj", "Book Era Malaj").
- The recall interval is the existing `Segmented` radiogroup.
- The Today tiles are links with a visible focus ring.
- Reduced motion is honoured through the existing global rule.

## 5. How it was verified

Everything ran against the isolated stack:

- a throwaway Postgres on :55432 (`dentalcare_demo`, `dentalcare_itest`);
- the API on :3100;
- the production web build on :5197.

The developer's own API on :3000 and database on :5432 were not touched by this pass.

| Check                          | Result                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Typecheck (all workspaces)     | pass                                                                                                     |
| Lint (`eslint .`)              | pass                                                                                                     |
| Unit tests                     | **722 passed** (45 suites)                                                                               |
| Integration tests              | **490 passed** (33 suites), including two new suites: `bill-charted-work` (8) and `recall-and-today` (4) |
| Build (shared, api, both SPAs) | pass                                                                                                     |
| Cloudflare dry-run             | pass: 3,622 KiB / 942 KiB gzip, bindings resolved                                                        |
| Browser walkthrough            | see below                                                                                                |

**The browser walkthrough** used the production build, in headless Chrome:

- As reception: Bill (2 lines from the chart), then Create invoice, then Take 8,000 L, then "Paid in full". A second Bill for the same patient pre-fills nothing.
- As the owner, uploading a real `.xlsx`: the columns were matched in Albanian, the date read as 01.01.1990, the rich-text name was joined, and the number-stored phone was intact.

**Format gate** (`npm run format:check`, which checks the files the working tree touches) reports 44 files:

- Every new file (`RecallPage.tsx`, `lib/xlsx.ts`, both integration suites, the two docs) and every file whose only differences were this pass's (`DashboardPage.tsx`, `AppLayout.tsx`, `InvoicesPage.tsx`, `polish.css`, …) is Prettier-clean.
- The 44 are hand-wrapped files that were already unformatted in `HEAD`. Five of them gained small edits here: `finance.service.ts`, `finance.dto.ts`, `invoices.controller.ts`, `patients.service.ts` and `patient-import.ts`. The edits follow the surrounding hand formatting. Reformatting those files wholesale is the rewrite that `scripts/format-check.js` deliberately avoids.

## 6. Remaining issues

1. **Calendar drag-to-move:** needs a server move endpoint with conflict answers first (§3).
2. **Charting outside a visit:** the chart does not send `appointmentId` when recording a procedure. Billing works by patient, not by visit: **Bill** offers all of the patient's unbilled work from the last 30 days. That is right for a desk, but a per-visit view would need the chart to pass the visit it was opened from.
3. **Recall has no "called, will ring back" state.** A patient who was called but did not book stays on the list until they book.
4. **Awaiting payment card** (dashboard): it still reads the newest 200 invoices to find today's billed patients. The open list itself could use `status=open`.
5. **Admin console:** the tenant detail page (about 1,370 lines) was not reworked.
6. **Your local database (:5432)** holds the DEMO clinic from earlier today, seeded before this pass. It does not have Jona's unbilled visit or the recall patients yet. To load them: `$env:DEMO_ENV='true'; npm run demo:reset` in `apps/api`. Your API container on :3000 also needs rebuilding to serve the new endpoints.

## 7. Production blockers

These are unchanged by this pass and carried from [PRE_LAUNCH_PRODUCT_POLISH.md §18](./PRE_LAUNCH_PRODUCT_POLISH.md):

- **Runtime and Hyperdrive:** a live connection and caching behaviour are still unverified.
- **Fiscalization:** a real clinic needs its CIS certificate and TCR codes, and a successful registration in the tax authority's test environment, before go-live.
- **Messaging providers:** there are no credentials, and delivery is unverified.
- **The demo as a public marketing account.** The seed refuses production by design, and `demo:reset` removes **every** clinic. Before DEMO exists in production, decide:
  - who can change it, given the published password `Demo@2026!`;
  - its trial expiry;
  - MFA enrollment on first sign-in;
  - how it is reset without touching real clinics.
- **The branch:** everything is uncommitted on `preserve/pre-production-sept-9-18`, alongside the earlier passes' work.
