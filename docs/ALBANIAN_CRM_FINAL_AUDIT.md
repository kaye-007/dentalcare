# DentalCare — Albanian CRM final audit

Date: 2026-09-28 · Follows [APPLE_EXPERIENCE_PASS.md](./APPLE_EXPERIENCE_PASS.md) and [COMPETITIVE_FEATURE_AUDIT.md](./COMPETITIVE_FEATURE_AUDIT.md) · Reference: CRMDent's public English page, read 2026-09-28 · Nothing was implemented in this pass.

**What this is.** A check of DentalCare against what an Albanian clinic expects from a serious dental CRM, with CRMDent's public feature list as the reference. The reference was used as a list of capabilities and nothing more:

- its design and interface were not looked at for reuse;
- nothing is proposed because CRMDent has it;
- a gap is only worth building if a clinic here would expect it, it adds real value, and it fits without making DentalCare harder to use.

**How it was checked.**

- **Code.** Every claim about DentalCare was read from the current code on `preserve/pre-production-sept-9-18` (uncommitted tree), not taken from earlier documents.
- **Screens.** The key screens were opened in the production build on an isolated stack (throwaway database, demo clinic). Four accounts were used (owner, reception, two dentists) at 390 px, and element widths were measured.
- **The reference.** CRMDent's page was read on 2026-09-28. Where its text and the brief's list differ, §2 says so.

**The short answer.**

- **Coverage.** Of the 18 capabilities in the brief's CRMDent list:
  - DentalCare covers **12**, some with UX work still to do;
  - covers **3 partly**: the estimates workflow, multiple currencies and email;
  - deliberately leaves out **3**: team chat, voice/video and AI radiograph analysis.
- **Where it goes further.** It goes further where Albania is specific: fiscalization, TVSH per service, WhatsApp messages sent from where the reason is, and a cash drawer that is counted.
- **The largest gaps are connections, not missing modules.** A treatment plan does not learn what was booked, done or paid. Two bugs were found in daily workflows (§4.2).
- **One decision outweighs every feature on this page.** CRMDent's interface speaks Albanian. DentalCare's is English, by choice (§4.1).

The §1 table judges each area against what a clinic needs. The §3 table judges it against what CRMDent claims. That is why data migration is "Partial" in one and "parity" in the other.

**Classes.**

| Class          | Meaning                                      |
| -------------- | -------------------------------------------- |
| **Strong**     | Exists and is already strong                 |
| **UX**         | Exists, but the experience needs work        |
| **Partial**    | Part of it exists; it needs completing       |
| **Missing**    | Potentially important, and not built         |
| **Not needed** | Deliberately excluded, with the reason in §7 |

---

## 1. DentalCare's current capabilities

| #   | Area                   | What DentalCare does today (verified)                                                                                                                            | Class       | The one thing to know                                                                                                                 |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Patients               | A record per patient. Search forgives a missing ë or ç, word order, and phone formats (+355, 0…). Excel import. Archive, never delete. WhatsApp opt-in recorded. | **Strong**  | —                                                                                                                                     |
| 2   | Patient chart (record) | The header answers who (allergies up front), next, last visit and balance. Needs attention, the history with a note box, medical history, lab work.              | **UX**      | The current treatment is not on the overview. Erisa Kola's proposed crown plan can only be seen in its tab.                           |
| 3   | Odontogram             | Arch and surface views, FDI and other notations, findings apart from procedures, signed procedures, perio chart.                                                 | **Strong**  | A tooth does not show its images or its planned work.                                                                                 |
| 4   | Treatments             | Service catalogue with prices, codes and TVSH category. Procedures logged and signed from the chart. **Bill** from the chart.                                    | **Strong**  | A logged procedure never names the plan line it delivers (§12).                                                                       |
| 5   | Treatment plans        | Draft → proposed → accepted → in progress → completed, or declined with a reason. Line and plan discounts. A cost engine. Billing a line twice is impossible.    | **Partial** | The interface cannot complete a plan line. "Completed so far" never moves, and **Invoice completed work** always refuses (§4.2).      |
| 6   | Appointments           | Patient → What for → When. Find a time. A taken slot is refused by the database and the next free times are offered. Move and check-in each have Undo.           | **Strong**  | "What for" does not offer the patient's accepted plan lines.                                                                          |
| 7   | Calendar               | List, day, week and month. By dentist or by room. The week is a per-day agenda for everyone. Phones open on the list.                                            | **Strong**  | Past visits stay on "Check in", and a check-in can show "Waiting 404 min". Nothing closes the day (§11).                              |
| 8   | Patient reminders      | A reminder in WhatsApp from any visit. A daily batch through the WhatsApp Business Cloud API. An automatic SMS and Viber engine.                                 | **UX**      | Most clinics start without a Meta-verified account. Until then, reminders go one visit at a time.                                     |
| 9   | Invoices               | Bill from the chart, TVSH per service, registration with the tax authority (queue, 48-hour limit), internal receipts, PDF.                                       | **Strong**  | The corrective invoice and the after-midnight invoice date are open hardening items.                                                  |
| 10  | Estimates              | A printable, bilingual PREVENTIV with a validity date, a signature line and a second currency (EUR and others).                                                  | **Partial** | It can only be printed. There is no WhatsApp share, no "waiting for a decision" and no "book the first visit" (§4.3).                 |
| 11  | Payments               | One payment sheet. Instalments. The method starts on the one last used. Receipt. Void with a reason.                                                             | **Strong**  | Payments are in the clinic's currency only.                                                                                           |
| 12  | Cash register          | A drawer with a float and a blind count, a tolerance per currency, manager approval, payouts and drops.                                                          | **UX**      | The screen shows one figure and no arithmetic. **Take cash out** and Expenses are separate records.                                   |
| 13  | Financial reporting    | Overview: today, the period, receivables ageing, production by clinician, room and procedure. Reports framed as questions. TVSH.                                 | **Strong**  | —                                                                                                                                     |
| 14  | Expenses               | Categories, cash, card or bank, void with a reason.                                                                                                              | **UX**      | There is no receipt photo. An expense is not linked to the drawer, a lab order or a supplier.                                         |
| 15  | Dental laboratory      | Preparing → At the lab → Back → Fitted, with due dates, lateness and Undo. It shows on the record, in Clinical › Today, on the dashboard and in Reports.         | **Strong**  | The patient cannot be told "your work is ready". The lab's cost does not become an expense (known).                                   |
| 16  | Inventory              | Opens on what needs attention: out of stock, running low, lots expiring. Lots, and movements with reasons.                                                       | **Strong**  | Use is recorded by hand. Nothing is deducted automatically per service, and that is fine for now.                                     |
| 17  | Suppliers              | Labs and suppliers as lists. Each item names its supplier. **Reorder** groups low stock by supplier, with WhatsApp and Call.                                     | **Strong**  | —                                                                                                                                     |
| 18  | Imaging / X-rays       | Kinds including panoramic and CBCT. Tooth, date and caption. Before/after comparison. Camera at the desk. Signed links, and every view logged.                   | **UX**      | The viewer has no zoom, pan or contrast. A tooth's images cannot be reached from the chart. Only before/after photos can be compared. |
| 19  | Documents              | Consent, referral, insurance, ID, report and other. ID capture by camera.                                                                                        | **Strong**  | Forms are uploaded, not generated. That is fine for now.                                                                              |
| 20  | Staff / roles          | Six roles on one permission matrix. MFA and sessions. Hours, leave, positions and home rooms. An activity trail.                                                 | **Strong**  | The interface is English only (a decision, §4.1).                                                                                     |
| 21  | Communication          | Messages from where the reason is: record, visit, invoice, recall row, lab. Albanian by default. Opt-out respected, history kept.                                | **Strong**  | Two reasons have no message: lab work ready, and a treatment estimate.                                                                |
| 22  | SMS / email / WhatsApp | WhatsApp by hand-off and by the Cloud API. SMS (Twilio) and Viber (Vonage) built. Email by hand-off only.                                                        | **UX**      | No provider has been used with a real account yet (a hardening item). WhatsApp first is right for Albania.                            |
| 23  | Reports                | Money, then Clinic, then Stock and lab: cancellations, no-shows, treatments, stock used, lab work. The TVSH card.                                                | **Strong**  | No-show counts are only as good as the day's visits being closed (§11).                                                               |
| 24  | Excel / PDF exports    | Reports export to Excel. Invoices, receipts and estimates as PDF or print.                                                                                       | **Strong**  | A clinic cannot export its own patient list.                                                                                          |
| 25  | Data migration         | Excel or CSV patients are read on upload: Albanian headers, one full-name column, opening balances to the ledger.                                                | **Partial** | Future appointments cannot be imported, so on switch day the calendar starts empty.                                                   |
| 26  | Mobile experience      | A phone shell with a tab bar. No page overflow from 320 to 1440 px, across three roles.                                                                          | **UX**      | On phones, 389 px of the treatment plan table is clipped. The dentist's Today view mis-sorts waiting patients (§4.2).                 |
| 27  | Multi-doctor workflows | A column or chip per dentist. "My patients" in Clinical › Today. Production by clinician. Home rooms. The dentist on each plan.                                  | **Strong**  | There is no per-dentist share (commission). Add it only if clinics ask.                                                               |

---

## 2. CRMDent's advertised capabilities

**On the page.**

- **Nine modules:**
  1. User list
  2. Patient chart
  3. Calendar
  4. Invoicing & reports
  5. Team chat with voice and video
  6. Dental lab
  7. Dental warehouse
  8. Panoramex X-ray with AI
  9. Clinic cash register
- **Beyond the modules:**
  - SMS and email ("team chat, SMS & email, with instant coordination and notifications");
  - daily email reports;
  - migration of patients, medical history and invoices, done by their team;
  - daily backups; Cloudflare DDoS protection; GDPR;
  - responsive on any device;
  - ten interface languages, Albanian among them;
  - setup "within 24–48 hours".
- **Plans and pricing:**
  - three plans: Standard without the lab and the warehouse, Professional with multiple branches, and Enterprise;
  - €6–10 per user, plus an €800 one-time setup fee.

**In the brief but not in the page's text.**

- **Estimates, Excel and PDF** do not appear in the text that could be read. They may be in images or in the demo.
- **Currencies** appear once, on the cash register ("every transaction and currency").
- **Radiographs** appear only inside the AI module.

All four are audited anyway.

**Not on the page at all:** fiscalization or tax, WhatsApp, online booking, a patient portal, native apps.

---

## 3. Capability differences

| CRMDent                 | DentalCare                                                                                          | Verdict                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Patient management      | Record, search, import                                                                              | Parity; DentalCare's search is stronger                 |
| Dental chart            | Odontogram and perio chart                                                                          | Parity                                                  |
| Appointments / calendar | Three-step booking, Find a time, Move and check-in with Undo                                        | DentalCare deeper                                       |
| Invoicing & reports     | Plus fiscalization, TVSH per service, Excel export                                                  | DentalCare stronger for Albania                         |
| Estimates               | Printable PREVENTIV with euro alongside; the workflow around it is partial                          | Partial (§4.3)                                          |
| Multiple currencies     | The drawer counts EUR, USD, GBP and CHF; estimates show a second currency; payments are in lek only | Partial                                                 |
| Clinic cash register    | Counted drawer with tolerance and manager approval                                                  | DentalCare deeper; the screen needs clarity             |
| Dental lab              | Clinic-side lifecycle; no technician portal                                                         | Parity for the clinic; the portal is excluded           |
| Dental warehouse        | Inventory, suppliers, reorder by supplier                                                           | Parity                                                  |
| Radiography             | Storage, kinds, comparison                                                                          | Parity; the viewer is basic                             |
| AI Panoramex            | —                                                                                                   | Excluded (§7)                                           |
| SMS                     | Built on Twilio, never used with a real account                                                     | Parity on paper                                         |
| Email                   | Hand-off only                                                                                       | Partial, deliberately                                   |
| Team chat, voice, video | —                                                                                                   | Excluded (§7)                                           |
| Daily email report      | —                                                                                                   | Missing: the evening summary, deferred until hardening  |
| Data migration          | Self-serve patients and balances; history as a service                                              | Parity with CRMDent's claim; appointments missing (§17) |
| Interface languages     | English                                                                                             | CRMDent stronger (§4.1)                                 |
| Multiple branches       | —                                                                                                   | Excluded for now (§7)                                   |
| Daily backups           | The provider's point-in-time recovery, never rehearsed                                              | A hardening item                                        |
| WhatsApp                | Contextual, in Albanian, recorded                                                                   | DentalCare only                                         |
| Fiscalization           | Registration, queue, certificate, plain status words                                                | DentalCare only                                         |

---

## 4. Important gaps

### 4.1 The interface language — a decision, not a silent fix

- **The comparison.** CRMDent offers Albanian and nine other languages. DentalCare's staff interface is English by decision (`lib/strings.ts`: "the product ships in English only"). Patient-facing text is Albanian.
- **Why it matters here.** A receptionist meets the language on every screen, every day. No feature on this page is seen as often.
- **The cost of changing it:**
  - 229 strings in the table;
  - roughly 500 more written inline in 68 of the 79 screen files, which never used the table;
  - the API's messages.

  It is large (L) and cross-cutting.

- **Recommendation.** The decision stays yours. If a target clinic's front desk is not at ease in English, this outweighs everything else in this document.

### 4.2 Two bugs in daily workflows

1. **Clinical › Today counts a checked-in patient as seen once their slot ends** (`ClinicalPage.tsx:131–137`).
   - In a clinic running late, the dentist is told "Everyone for today has been seen" while the patient sits in the waiting room.
   - The same rule files visits that never arrived under "Seen today". At 19:00 in the demo, 4 of Dr. Dervishi's 7 "seen" patients had never been checked in.
2. **The treatment plan is a dead end.**
   - The interface never completes a plan line: nothing calls `updateItem`, and the chart never sends `planItemId`.
   - So **Invoice completed work** can only answer "No completed, unbilled procedures on this plan".
   - Only the demo seed, which writes completed lines straight into the database, makes plans look alive.
   - `POST /treatment-plans/:id/invoice` has no integration test.

### 4.3 Plans and estimates are islands

The data model already joins them: `clinical_procedures.plan_item_id`, `invoice_line_items.plan_item_id` with a unique index, and lab orders on a plan line. The interface does not use these links:

- **Nothing that happens reaches the plan:**
  - booking a visit does not know the plan;
  - logging a procedure in the chart does not know the plan;
  - billing from the chart does not mark the plan's lines.
- **The plan cannot answer "what has been paid" or "what is next".**
- **Its buttons are named after states:** "Mark proposed", "Mark accepted". An in-progress plan with 60,000 L of completed work still offers "Mark declined".
- **Adding a line is a nine-field form.**
- **On a phone the table stops after Qty.** Fee, total and each line's status are clipped: the content is 389 px wider than the card at 390 px, measured.

### 4.4 Switching: the calendar cannot come across

A clinic moving in brings its patients and balances. It cannot bring its **future appointments**, so on switch day the calendar is empty and the old system stays open beside the new one. CRMDent migrates "patients, medical history and invoices" as a service. Appointments are the part a clinic needs on day one.

### 4.5 Day-one reminders

The batch "select tomorrow's patients → preview → send" needs the WhatsApp Business Cloud API: Meta verification and approved templates. Most small clinics use the WhatsApp app on a phone. Until they connect, reminders go one at a time, each from its own visit.

---

## 5. Where DentalCare is already stronger

- **Fiscalization:** registration with the tax authority, the queue, the 48-hour limit, the certificate and plain status words. CRMDent's page does not mention tax at all.
- **TVSH per service,** with an on-screen report and an Excel export for the accountant.
- **WhatsApp from where the reason is:**
  - in Albanian, recorded, and opt-out respected;
  - the reasons: reminder, follow-up, balance, check-up invitation, contacting the lab.

  CRMDent lists SMS and email.

- **The cash drawer's blind count,** tolerance and manager approval, instead of a running total.
- **Undo instead of "Are you sure?"** for moves, check-ins, lab steps and Fitted (within ten minutes).
- **Search that forgives Albanian spelling,** word order and phone formats, and respects permissions.
- **Self-serve import** that reads the clinic's own Excel file ("6 patients found · Import 4").
- **Estimates in lek with euro alongside,** in Albanian with English beneath.
- **Isolation, activity trail and record-access log,** proven by 525 integration tests on a real database.

---

## 6. Areas where DentalCare's UX needs improvement

| Where                      | What a user meets today                                                 | The lighter version                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Treatment plan             | A nine-column table, buttons named after states, a nine-field line form | Lines as a list with a status mark. One primary action for the plan's moment. Service and tooth to add a line; code, quantity and discount under More |
| Estimate                   | Print only                                                              | Print, or send on WhatsApp. The plan remembers that it was given                                                                                      |
| Patient record             | No current treatment on the overview                                    | One line: "Implant 36 · 2 of 3 done · 40,000 L to go · next: Kurorë 36 — **Book**"                                                                    |
| Cash drawer                | One figure: "Expected cash 22,000 L"                                    | The story: started with 20,000 · cash in +2,000 · cash out −0 · expected 22,000                                                                       |
| Take cash out and Expenses | Two records for one event                                               | One: **Take cash out** asks what it was for and files the expense                                                                                     |
| Reminders                  | The batch needs the Cloud API                                           | **Remind tomorrow's patients**: one tap per patient hands the message to WhatsApp and moves to the next                                               |
| Imaging                    | A plain image in a dialog                                               | Zoom, pan and contrast. "Images of this tooth" from the chart. Any two images side by side                                                            |
| End of day                 | Past visits stay "Check in"; a check-in waits forever                   | After closing time, one short list: "4 didn't arrive · 1 still checked in". Each row gets its one step                                                |

---

## 7. Features we should NOT add

| Feature                                             | Why not                                                                                                                                                 | What would change it                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Team chat                                           | Staff already coordinate in WhatsApp and Viber groups                                                                                                   | —                                                               |
| Voice and video calls                               | The same, and a large real-time system far from the clinic's work                                                                                       | —                                                               |
| AI radiograph analysis (Panoramex)                  | CRMDent's module claims diagnoses, therapy and antibiotic recommendations. That is medical-device territory: clinical validation, liability, regulation | A validated partner integration, plugged into the imaging kinds |
| Technician portal                                   | Albanian labs take work by phone and WhatsApp                                                                                                           | A lab that wants digital orders from several clinics            |
| Multiple branches                                   | Most clinics here are single-site, and branches touch every screen and report                                                                           | The first multi-site customer                                   |
| Recurring appointment series                        | Edit-one-or-all, far-future conflicts, holidays, leave                                                                                                  | Orthodontic clinics asking: a "book the next N visits" helper   |
| Purchase orders and supplier accounts               | Bookkeeping, not clinic work. Reorder by message covers how clinics buy                                                                                 | A clinic with a purchasing role                                 |
| Automatic email to patients                         | Patients here answer WhatsApp. Email stays a hand-off                                                                                                   | —                                                               |
| A separate estimates module                         | The plan is the estimate. A second object means reconciling two versions of the same quote                                                              | —                                                               |
| Automatic stock deduction per service               | Every service needs a materials list first, and wrong counts are worse than none                                                                        | Implant clinics asking; optional per service                    |
| Gamification, complex dashboards, duplicate reports | Every screen already answers a question; more would dilute them                                                                                         | —                                                               |

---

## 8. Features worth considering

**In the priority list below:**

- the plan loop;
- the estimate workflow;
- the reminder run;
- the drawer story;
- the day close;
- the lab-ready message;
- importing appointments;
- the imaging viewer.

**When clinics ask, not before:**

| Feature                                            | Why it could matter                                                                                | Size |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---- |
| Euro cash at the desk                              | Diaspora patients pay in euro; today the drawer can count euro but a payment cannot be taken in it | M    |
| Per-dentist share                                  | Associates are often paid a percentage; production by clinician already exists                     | M    |
| Patient-list export                                | "Your data is yours", and a trust point when a clinic is choosing                                  | S    |
| Search: appointments, plans, Albanian action words | "takim i ri", "pagesë", "Arben nesër"                                                              | S    |
| Receipt photo on an expense                        | The accountant asks for the paper                                                                  | S    |
| Lab cost to expense                                | Known gap: the lab card and the books should agree                                                 | S    |
| Printed prescriptions and consent forms            | Written on paper today; not on CRMDent's list                                                      | M    |

---

## 9. Mobile gaps

Measured and seen at 390 px:

- **Check the treatment plan.** The plan table is clipped by 389 px: fee, total and each line's status are hidden.
- **Open today's appointment.** A waiting patient drops out of the dentist's Today once the slot ends (§4.2).
- **Review the patient.** The record's overview has no treatment line (§10).

**Fine and kept:**

- the shell and tab bar;
- no page overflow;
- the calendar list;
- the owner's phone dashboard (today, money, attention, month);
- the drawer;
- inventory's attention bars;
- the record header.

**Not checked on a phone in this pass:** logging a procedure from the chart at 390 px. Check it before the chart learns about plan lines.

---

## 10. Patient workflow gaps

| Question         | On the record today                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Who              | Yes: name, age, city, allergies in the header                                                        |
| Next             | Yes: the next appointment, with **Move**                                                             |
| Clinical history | Yes: the history and medical history; the chart is one tab away                                      |
| Treatment        | **No.** The current plan, its progress and its next step are not on the overview                     |
| Balance          | Yes: "Settled", or what is owed                                                                      |
| Attention        | Yes, but it misses "estimate given, waiting for a decision", which is money the clinic is waiting on |

---

## 11. Appointment gaps

- **Keep as it is:** density, choosing a dentist or room, availability, rescheduling, mobile booking, and the day and week views, for several dentists and rooms. The three-step panel is not to be rebuilt.
- **What for, from the plan.** With an accepted plan, "What for" should offer its next unbooked line first.
- **Closing the day.** Visits that are past but never checked in stay on "Check in". A check-in that never reached the chair counts up forever ("Waiting 404 min"). No-show figures in Reports depend on these being resolved.
- **Reminders:** see §16.

---

## 12. Clinical gaps

- **The chart and the plan.** When a procedure is logged on a tooth that has a plan line, offer that line ("From the plan: Kurorë 46"). The API already completes the line when told.
- **The dentist's Today:** the classification bug (§4.2).
- **Imaging:**
  - a viewer that zooms and adjusts contrast;
  - a tooth's images from its chart panel;
  - who took or read the image (known gap).

---

## 13. Financial gaps

- **Estimate to invoice.** Blocked by the dead end (§4.2). Once a plan line is completed by the visit or the chart, billing from the chart and from the plan must meet on the same lines. Then the plan can say what has been paid.
- **The drawer.** Show its arithmetic. **Take cash out** should file the expense.
- **Foreign-currency payments** (euro cash): consider (§8).
- **Expenses:** a receipt photo; lab cost to expense (known).
- **Tracked as hardening, not here:** invoice dates after midnight, duplicate protection on money routes, the corrective invoice.

---

## 14. Inventory gaps

- The first screen already answers "what needs attention?" (out of stock, running low, expiring, **Reorder**).
- **Small:** the Reorder bar could say how many suppliers it covers ("Reorder from 4 suppliers"). Receiving stock could offer "Record the bill", as lab work should.
- **Not to add:** automatic deduction per service (§7).

---

## 15. Lab gaps

- **Tell the patient.** When work is back, offer a message: "Your crown is ready — call us to book the fitting".
- **Lab cost to expense** (known).
- **Nothing else.** The four states, due dates, lateness and Undo are enough. Do not add states.

---

## 16. Communication gaps

What a clinic actually says, and whether it is one tap away:

| Message              | Today                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| Appointment reminder | Yes, per visit. The daily batch needs the Cloud API; without it there is no run through tomorrow's list |
| Recall               | Yes: a check-up invitation from the recall row                                                          |
| Payment reminder     | Yes: from the invoice                                                                                   |
| Lab update           | **No** message to the patient; only Contact the lab                                                     |
| Treatment            | **No:** the estimate cannot be sent                                                                     |

Keep SMS and Viber as options, and email as a hand-off. Do not add team chat.

---

## 17. Migration gaps

- **Future appointments.** Import them from Excel (date, time, patient, dentist, reason) in the same "Bring your clinic" flow. This is the real switching blocker.
- **History and invoices.** Keep these as a service per clinic, as CRMDent does. Every source is different.
- **Switching from CRMDent.** When a clinic switches from CRMDent, ask for a sample export and add a column preset for it.

---

## Prioritized implementation list

The order follows what a clinic meets every day, then the risk of leaving it.

**Sizes:**

- **S:** one focused change.
- **M:** several screens and an API change.
- **L:** cross-cutting.

The last column names the question from the brief's Apple test that each item answers.

**P1 — fix what is wrong today**

| #   | Item                                                                                                                                                                                                                          | Size | Apple test                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------- |
| 1   | **Clinical › Today.** A checked-in patient is never "seen" until the visit moves on. A visit that never arrived is shown as such, with No-show and Arrived.                                                                   | S    | Can the result be clearer?          |
| 2   | **The plan loop.** Booking a plan line links the visit. Completing the visit or logging the procedure completes the line. Billing from the chart marks the same lines. Remove the dead end. Add the missing integration test. | M    | Can we pre-fill what we know?       |
| 3   | **The plan on a phone.** Lines as a list: description, tooth, price, status mark. Nothing clipped.                                                                                                                            | S    | No tiny controls, no hidden columns |

**P2 — the estimate workflow**

The flow is: create plan → review → print or send → accepted → book the first visit.

| #   | Item                                                                                                                                                                                                                                          | Size | Apple test                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------- |
| 4   | **Plan actions by moment:** Draft → **Give to the patient** (print or WhatsApp); Proposed → **Accepted** / **Declined**; Accepted → **Book the first visit**; In progress → **Book next: Kurorë 36**. Add a line with service and tooth only. | M    | Can we remove a decision?                   |
| 5   | **The treatment line on the record,** and "estimate waiting for a decision" in Needs attention, on the record and the owner's dashboard.                                                                                                      | S    | Understand the patient without five modules |

**P3 — the front desk**

| #   | Item                                                                                                         | Size | Apple test                             |
| --- | ------------------------------------------------------------------------------------------------------------ | ---- | -------------------------------------- |
| 6   | **Remind tomorrow's patients,** without the Cloud API: a hand-off run through the list, recorded as it goes. | S–M  | Can the same task be done faster?      |
| 7   | **The drawer's story** (started with, cash in, cash out, expected). **Take cash out** files the expense.     | M    | Explain what happened without a dialog |
| 8   | **Close the day's visits:** after closing time, one list of what is still open, each row with its one step.  | S    | Keep reports true without asking       |
| 9   | **Lab work ready:** a message purpose, offered where the lab row says "Back from the lab".                   | S    | Contextual action                      |

**P4 — switching and imaging**

| #   | Item                                                                                                             | Size | Apple test                         |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------- |
| 10  | **Import future appointments** in "Bring your clinic".                                                           | M    | Moving in is an afternoon          |
| 11  | **Imaging:** a viewer with zoom, pan and contrast; a tooth's images from the chart; any two images side by side. | M    | Organization and context before AI |

**P5 — when clinics ask:** the list in §8.

**Decisions, not build items:**

- **The interface language** (§4.1). The largest competitive exposure, and L to change.
- **The evening summary for the owner.** CRMDent's "daily email report". Recommended, and deferred by you until hardening is done.
- **Multiple branches.** Not until a multi-site customer.

**Relation to the hardening track.** Items 1 and 2 are correctness bugs and can travel with it. The rest can follow the hardening RED items or be interleaved with them.
