# DentalCare — the experience pass

Date: 2026-09-28 · Follows [FINAL_SIMPLICITY_PASS.md](./FINAL_SIMPLICITY_PASS.md) · Companion: [COMPETITIVE_FEATURE_AUDIT.md](./COMPETITIVE_FEATURE_AUDIT.md) · Branch `preserve/pre-production-sept-9-18`, uncommitted

**The brief.** Keep the power and remove the friction, building on the previous pass rather than replacing it. Inspect before coding, verify rather than assume, and improve what exists instead of duplicating it. Use a comparable product's feature list as a checklist of capabilities, not as a design to copy.

**What the inspection found.** The previous pass's foundation held up. Every flow it built still passes. The gaps were elsewhere:

- **Work the clinic does that DentalCare did not know about.**
  - Lab work was a notebook at the desk.
  - Suppliers were a name in someone's phone.
  - A patient due for a check-up could be called, but not messaged.
- **Capabilities that existed but could not be reached.**
  - The TVSH report had an API and no screen.
  - Contextual WhatsApp messages had lost their way in (fixed early in this pass).
  - Reports could not be exported.
- **Answers in the wrong place, or wrong.**
  - Reports counted days on the server's clock, so money taken after midnight in Tirana landed on the day before.
  - The Financials chart's axis was off by a factor of a hundred.
  - A new Albanian clinic wrote to its patients in English.

The visual identity (Ink & Ember) is unchanged. Every visual change is in §2.1, so any of them can be vetoed.

---

## 1. What was already excellent from the previous pass

These were re-verified in the browser on the new build, and nothing in them was rewritten:

- **Booking.**
  - The three-step panel (patient, what for, when) with Find a time.
  - A slot taken by another desk is refused by the database, and the next free times are offered at once ("That time was just taken…").
- **Move with Undo** ("Moved Mimoza Toska to Today, 13:00 · Undo" → "…is back at Today, 13:30").
- **Check-in with Undo** ("Ardian Kurti is checked in · Undo" → "…is no longer checked in").
- **Search (Ctrl/⌘+K).**
  - Grouped results: patients, services with **Book it**, actions, and Go to.
  - Forgives a missing ë or ç and a surname typed first ("cela era" finds Era Çela, with her next visit).
- **Role dashboards** that open on what needs attention.
- **The payment sheet**: one button, and the receipt shown when it is done.
- **The patient header** with its four actions.

This pass extended several of them: new rows in Needs attention, a new default in the payment sheet, and a new action in the visit panel's menu. None was replaced.

---

## 2. What was changed

| Area            | Change                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lab work (new)  | Lab orders from order to fitting (0020): the Lab page, a card on the patient's record, a notice in Clinical › Today, dashboard and report rows. Contact the lab by WhatsApp or Call.                                                  |
| Suppliers (new) | Labs and suppliers are lists of their own (0020). Each item says who it is reordered from, and **Reorder** groups low stock by supplier.                                                                                              |
| Messages        | One message sheet, opened from where the reason is: patient, visit, invoice, recall row, lab. A new **check-up invitation** (0022). New clinics in Albania and Kosovo write to patients in Albanian.                                  |
| Patient record  | **Needs attention** list (lab late or back, accepted treatment unbooked, check-up due, no phone). **Lab work** card, **Message**, **Order lab work**.                                                                                 |
| Reports         | Rebuilt around questions (Money, Clinic, Stock and lab). The TVSH card surfaces an existing API. **Export** to Excel. Days follow the clinic's calendar.                                                                              |
| Payment         | The method starts on the one this bill was last paid with.                                                                                                                                                                            |
| Imaging         | **Panoramic (OPG)** and **CBCT** are kinds of their own (0021), recognised by file name.                                                                                                                                              |
| Import          | "Bring your clinic": a recognised file is read and checked on upload, then summarised ("6 patients found · Ready 4 · Already in DentalCare 1 · Need a look 1 · Import 4 patients"). A single full-name column works.                  |
| Owner dashboard | The Collected-today tile also says what was billed and spent.                                                                                                                                                                         |
| Fixes           | Report days on the clinic's clock; Undo after **Fitted** (it failed); the Financials axis ×100; bar lists clipped at card edges; the phone import table out of keyboard reach; the record's Message and Move links cut off on phones. |

### 2.1 What was visually changed (the veto list)

| #   | Change                                                                                                                                                                                                                                                                         | Where it lives                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 1   | **Lab page** under Clinical, in sections: Needs attention (late, or back to fit), At the lab, Preparing, then finished work. Each row has its one next step as a button (Sent, Received, Fitted) and ⋯ for Edit, Cancel, Reinstate.                                            | `LabPage.tsx`, `LabWork.tsx`; `.labrows`, `.labrow` |
| 2   | **Lab work card** on the patient's record, with **Order**.                                                                                                                                                                                                                     | `LabWork.tsx`, `PatientProfilePage.tsx`             |
| 3   | **Lab order sheet**: what the lab is making, teeth, due date, lab (or add one inline), dentist, material, shade, price, notes.                                                                                                                                                 | `LabOrderSheet.tsx`; `.laborder`                    |
| 4   | **Needs attention card** on the patient's record, rows with a button (e.g. "Pllakë nate is back from the lab, ready to fit · Book fitting"). Hidden when there is nothing to say.                                                                                              | `PatientProfilePage.tsx`; `.attention--record`      |
| 5   | **Clinical › Today** lab line under the patient in the chair: "Kurorë … is back from the lab. **Fitted**".                                                                                                                                                                     | `ClinicalPage.tsx`; `.clin__lab`                    |
| 6   | **Message sheet**: what it is about (segmented), the message exactly as it will read, **Call** and **Send on WhatsApp**.                                                                                                                                                       | `MessageSheet.tsx`; `.msgsheet`                     |
| 7   | **Recall rows**: a message icon beside Call.                                                                                                                                                                                                                                   | `RecallPage.tsx`                                    |
| 8   | **Inventory header**: a **Suppliers** button. The low-stock bar carries **Reorder**; rows gain **Supplier** in ⋯.                                                                                                                                                              | `InventoryPage.tsx`; `.alertbar__action`            |
| 9   | **Reorder sheet**: one box per supplier with WhatsApp and Call, then "No supplier yet" with **Set supplier**.                                                                                                                                                                  | `Suppliers.tsx`; `.reorder`                         |
| 10  | **Suppliers and labs list** (add, rename, phone, retire).                                                                                                                                                                                                                      | `PartnersModal.tsx`; `.partners`                    |
| 11  | **Import summary card** after upload, with Ready / Already in DentalCare / Need a look, **Import N patients**, and **Adjust columns**.                                                                                                                                         | `PatientImportPage.tsx`; `.import-summary`          |
| 12  | **Reports**: small uppercase section labels (MONEY, CLINIC, STOCK AND LAB), each followed by its figures and cards. There is a new TVSH card and Lab work card, and **Export** in the header. While a new period loads, the old figures dim instead of flashing to a skeleton. | `ReportsPage.tsx`; `.reports`                       |
| 13  | **Bar lists keep the card's gutter** (Reports and Financials). They had run to the card edges, clipping the last figure.                                                                                                                                                       | `.card > .bars`                                     |
| 14  | **Bar lists on phones**: the name and figure on one line, the bar under them (was three lines per row).                                                                                                                                                                        | `.bars__row` at ≤720 px                             |
| 15  | **Financials chart axis** reads 1M, 2M, 3M, 4M (it read 100M–400M: minor units).                                                                                                                                                                                               | `RevenueChart.tsx`                                  |
| 16  | **Owner dashboard**: "Collected today" has a second line, "18,500 L billed" (and "… spent" on days with spending).                                                                                                                                                             | `DashboardPage.tsx`                                 |
| 17  | **Dashboard Needs attention** gains rows for lab work (late, back to fit), fiscal problems and invoices unpaid for over 60 days, in the existing row style.                                                                                                                    | `DashboardPage.tsx`                                 |
| 18  | **Record facts on phones**: **Message** (beside the phone number) and **Move** (beside the next visit) sit on their own line under the value. The one-line cell had cut them off.                                                                                              | `.profile__facts` at ≤760 px                        |

---

## 3. Why

- **Lab work and suppliers.** Every crown, bridge and denture goes through a lab, and every material through a supplier. A clinic asked "is Ylli's denture back?" had to find the notebook. Now the answer is on the patient's record, the Lab page and the dashboard. It arrives in the chair's view the moment the patient sits down.
- **Messages from where the reason is.** A reminder is about a visit, a balance note about an invoice, an invitation about a check-up that is due. Opening the message from that place means it is already the right message, with the right date or amount, in the clinic's language. Nobody composes, nobody retypes. The desk's own WhatsApp sends it, and DentalCare keeps the record.
- **Albanian by default.** A clinic created with Tirana's time zone, lek and +355 phones wrote to patients in English until someone found the setting. The defaults now agree with each other.
- **Reports as questions.** An owner opens Reports to ask "how much came in, what went out, what is owed, how busy were we, what did we do, what did we use, where is the lab work". The page answers those in that order, then shows the detail. Export is for the accountant. The advanced layer, a custom date range and (in the export) TVSH split by fiscal and internal documents, stays one step away.
- **The owner's view, in the brief's order.**
  - **Today:** appointments (and how many are done), collected with what was billed and spent, what is still owed, the cash drawer.
  - **Needs attention:** invoices unpaid for over 60 days, low stock and expiring lots, lab work late or back to fit, patients due for a check-up, fiscal problems. Each row appears only when there is something to say.
  - **Then the detail:** today's list, this month, awaiting payment.
- **The payment default.** Instalments are the norm in dentistry. The second payment on a bill is almost always made the way the first was, so the sheet starts there, visibly and in large type.
- **Import that reads the file.** "Map your columns" is where switching software stops feeling easy. When the headers are recognisable (Emri, Mbiemri, Telefoni…), there is nothing to map.
- **Fixes.**
  - A report that files a 00:30 payment under yesterday is wrong.
  - An Undo that fails is worse than no Undo.
  - An axis that says 400M lek frightens an owner.

---

## 4. Capabilities preserved

Nothing was removed, renamed out of reach, or hidden behind a new step:

- **Calendar:** all views, Find a time, taken-slot recovery, Move / check-in with Undo, the waiting pill.
- **Patient record:** dental chart, perio, procedures (sign, withdraw), notes, medical history, treatment plans and estimates, documents, camera capture, before/after compare, message history.
- **Money:** Bill from the chart; invoices; the payment sheet (now with a default); receipts and PDF; fiscalization and the fiscal queue; the cash drawer with count and approval; expenses; Financials; the activity trail.
- **Stock:** items, lots and expiry, movements with reasons, alerts.
- **Search and navigation:** the command palette (it also finds the new Lab page), role dashboards, the phone shell.
- **Access:** the permission matrix. The new lab permissions follow the same rules; the route-coverage and matrix specs pass.

The previous pass's flows were re-run on this pass's build (§16).

---

## 5. Capabilities added

| Capability                                                                                                                                  | Where                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Lab orders with a lifecycle (Preparing → At the lab → Back from the lab → Fitted; cancel with reason; reinstate), due dates, lateness, cost | 0020; `/api/lab-orders`; Lab page, patient card, Clinical › Today, dashboard, Reports |
| Undo on every lab step. **Fitted** can be undone for ten minutes, then it is final.                                                         | `lab-status.ts` (`FITTED_UNDO_MS`)                                                    |
| Labs and suppliers as partners; an item's supplier; Reorder grouped by supplier                                                             | 0020; `/api/labs`, `/api/suppliers`, `PUT /inventory/:id/supplier`                    |
| Check-up invitation message (Albanian and English, with and without the clinic phone)                                                       | 0022; `messages.ts` (`recall_invitation`)                                             |
| Message entry points: patient, visit (reminder, follow-up), invoice (balance), recall, lab                                                  | `lib/messaging.tsx`, `MessageSheet.tsx`                                               |
| New clinics in Albania (+355) and Kosovo (+383) message in Albanian                                                                         | `tenants.service.ts`                                                                  |
| Panoramic (OPG) and CBCT document kinds                                                                                                     | 0021; `DOCUMENT_KINDS`                                                                |
| Reports: cancellations, no-shows, treatments performed, stock used, lab summary; TVSH on screen; Excel export                               | `reports.service.ts`, `ReportsPage.tsx`, `xlsx-write.ts`                              |
| Import: auto-read, summary, full-name column, Albanian headers                                                                              | `patient-import.ts`, `PatientImportPage.tsx`                                          |
| Payment method defaults to the last one used on the bill                                                                                    | `InvoiceDetailPage.tsx`                                                               |

---

## 6. Capabilities deliberately NOT added

The reasons, and what would change each decision, are in [COMPETITIVE_FEATURE_AUDIT.md §3](./COMPETITIVE_FEATURE_AUDIT.md#3-deliberately-not-added-now-and-why). In short:

- **Recurring appointments.** The chair's "Next visit" plus Find a time covers it; a series adds risk to the calendar.
- **AI radiograph analysis.** Regulatory and clinical-validation weight; the brief rules out speculative AI.
- **DICOM viewer.**
- **Team chat and video.**
- **Technician portal.**
- **Purchase orders and supplier accounts.**
- **Multiple branches.**
- **Patient online booking.**
- **A daily email summary.** Recommended next (§18).

---

## 7. Mobile improvements

- **Reports on a phone.**
  - The chosen period stays in view in the sideways-scrolling period row (it was cut off).
  - Bar rows are two lines instead of three.
  - The monthly chart is drawn narrower, so month names are readable (they were about 4 px).
- **Message sheet at 390 px.** At most three purposes are offered. Reminder and Check-up exclude each other, so the segmented control never overflows.
- **Record on a phone.** The Needs attention list sits right under the header's four actions; the Lab work card follows the medical history.
- **Import review on a phone.** The sideways-scrolling table is now a labelled, focusable region.
- **Record facts on a phone.** Message beside the phone number, and Move beside the next visit, were cut off by the cell's ellipsis: invisible, yet still reachable by Tab. They now sit under their values.
- **Checked** at 320, 375, 390, 414, 768, 1024, 1280 and 1440 px, for three roles: no horizontal overflow anywhere (§16).

---

## 8. Desktop improvements

- **Reports use the width.** Two columns of cards under each question: where money came from beside where it went, how patients paid beside TVSH, practitioners beside treatments, stock used beside lab work.
- **Financials.**
  - The axis is in lek.
  - Receivables, production-by-clinician and production-by-procedure cards now keep their gutter; figures like "285,000 L · 19× · avg 15,000 L" were clipped.
- **Lab page.** Sections side by side where there is room; one next step per row.

---

## 9. Appointment improvements

The appointment flow was **evaluated, not rebuilt**. It held up in every re-run flow. Changes:

- **The visit panel's ⋯ menu** has **Send a reminder** for an upcoming visit and **Send a follow-up** for a completed one. They open the message sheet with the right visit already chosen.
- **Message-only users.** The panel's status buttons now require permission to change appointments, so someone who may only message patients sees the messages and not the status steps.
- **Recurring appointments** are not in this pass; see §6.

---

## 10. Patient improvements

The record now answers its five questions from the top:

| Question                 | Answer on the record                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Who**                  | Name, sex, age, city; allergies in the header (a severe one as a banner)                                                                         |
| **Next**                 | Next appointment, with Move                                                                                                                      |
| **What happened**        | Last visit; history (coming up, before)                                                                                                          |
| **What needs attention** | New list: lab work late or back to fit; accepted treatment with nothing booked; due for a check-up (six months, nothing booked); no phone number |
| **What they owe**        | Balance ("Settled", or the amount)                                                                                                               |

- **Primary actions** are **Appointment**, **Treatment**, **Payment** and **Note**. **Message** sits beside the phone number, the way Move sits beside the next visit. **Send a message** and **Order lab work** are also in the header's ⋯ menu.
- **The Lab work card** lists the patient's lab work with its one next step.

---

## 11. Clinical improvements

- **Clinical › Today.** When the patient in the chair (or next) has lab work back from the lab, it says so under their name, with **Fitted** and Undo.
- **Clinical → treatment → invoice → payment → receipt → books.** Walked end to end as reception, with nothing re-entered:
  1. Jona Meta's two charted fillings pre-filled the bill.
  2. **Create invoice** opened the payment sheet.
  3. 3,000 L by card left "5,000 L still to pay".
  4. Opened again, the sheet started on **Card**, "Pay 5,000 L".
  5. "Paid in full".
  6. The receipt PDF generated (HTTP 200, a valid PDF).
- **Billing the same work again** pre-fills nothing, so work cannot be billed twice.
- **Imaging.** The panoramic and CBCT kinds (§5). Clinician attribution for an image is still missing (§17).

---

## 12. Inventory improvements

The first screen already answered "what needs my attention" (low stock, expiring lots). This pass added what to do about it:

- **Suppliers.** A list, and a supplier per item.
- **Reorder.** From the low-stock bar: everything low, grouped by who it comes from, each with WhatsApp and Call. Items with no supplier are listed with **Set supplier**.
- **Consumption.** Reports › Stock used, by item.
- **Audited, not built:** purchase orders, receiving against an order, supplier balances. The reasons are in the audit, §1.

---

## 13. Lab improvements

A lean, complete workflow; the brief's five states map as follows:

| Brief     | DentalCare                               | Stamped       |
| --------- | ---------------------------------------- | ------------- |
| Preparing | Preparing                                | ordered       |
| Sent      | At the lab                               | `sent_at`     |
| At lab    | At the lab (late once past the due date) | —             |
| Received  | Back from the lab                        | `received_at` |
| Fitted    | Fitted (final after ten minutes)         | `fitted_at`   |

- A step may be skipped forward; the missing stamp is filled.
- Back is one step: that is what Undo does.
- Cancelling asks why, and a cancelled job can be reinstated to where it was.
- The database refuses a status its stamps contradict.
- **Found in this pass's walkthrough and fixed:** Undo after **Fitted** was offered and then refused ("Fitted lab work is finished"). Fitted now has a ten-minute grace, and an Undo confirms what it put back ("…is back from the lab, waiting to be fitted").

---

## 14. Migration improvements

**Bring your clinic to DentalCare** (Patients › Import):

- An Excel or CSV file whose name columns are recognised is checked straight away:
  - Albanian headers: Emri, Mbiemri, Telefoni, Datëlindja;
  - English headers;
  - one "Emri dhe mbiemri" / full-name column.
- It opens on "**N patients found** in file.xlsx", with Ready / Already in DentalCare / Need a look, **Import N patients**, and **Adjust columns** for the rest.
- Rows that share a phone with an existing patient (families) can be included with one checkbox.
- Nothing is saved until Import. Batches land whole or not at all, and opening balances post to the ledger.

**Verified with files written by the new Excel writer:**

- **Albanian columns, six rows:** 4 imported. Era Çela was recognised as already here, and "31.02.1990" was flagged.
- **A full-name file:** 3 imported. "Ana Maria Dushku" became Ana Maria / Dushku.

---

## 15. Accessibility verification

- **axe (WCAG 2 A and AA)** found no violations on:
  - the Lab page, Reports, two patient records, the recall list, Inventory, Import, Financials, Clinical, the dashboard and an invoice (owner, 1440 px);
  - the message sheet, lab order sheet, reorder sheet, suppliers list and import summary, at 1280 and 390 px.
- **One serious issue found and fixed.** The import review table scrolled sideways on a phone but could not be reached by keyboard (`scrollable-region-focusable`). It is now a labelled region with `tabIndex`, and axe passes.
- **Focus you cannot see, found by looking.** On a phone the record's Message and Move links were cut off yet still took focus. They are now visible (§7), and axe passes on the records at 390 px.
- **Keyboard.**
  - Every new action is a real button or link.
  - The message purposes are a radio group.
  - Icon-only buttons are labelled ("Message Valon Vata", "Call …").
  - Toasts carry their Undo as a button.

---

## 16. Test results

All run on this pass's final code, against the isolated stack only: throwaway Postgres on :55432, API on :3100, previews on :5197 and :5196. The developer's own database and API were never touched.

| Check                      | Result                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typecheck (all workspaces) | pass                                                                                                                                                                                                                                                                                                                                                               |
| Lint                       | pass                                                                                                                                                                                                                                                                                                                                                               |
| Unit tests                 | **759 passed** (48 suites), was 739. New: lab lifecycle (incl. the Fitted grace), the Excel writer, full-name import, and the check-up invitation in both languages                                                                                                                                                                                                |
| Integration tests          | **525 passed** (36 suites), was 504. New: `lab-work.itest` (12), `reports-questions.itest` (3), radiograph kinds (2), new clinics' message language (2), check-up invitation (2). Run with `TZ=Europe/Tirane`; report days also pass with `TZ=America/New_York`                                                                                                    |
| Migrations                 | 0020–0022 applied to both throwaway databases. 0021 and 0022 rollbacks were run against real rows inside a rolled-back transaction; 0020 was taken down and up                                                                                                                                                                                                     |
| Build                      | pass. Main chunk 350.4 kB (110.6 kB gzip), up 11.6 kB. The message sheet and lab order sheet are lazy chunks (7.4 and 6.9 kB)                                                                                                                                                                                                                                      |
| Cloudflare dry-run         | pass. API 3,669.4 KiB / 955.0 KiB gzip                                                                                                                                                                                                                                                                                                                             |
| Excel export               | The downloaded workbook opens in openpyxl with warnings as errors. Collected, spent, net and outstanding match the screen exactly                                                                                                                                                                                                                                  |
| Format gate                | 52 files, was 46 at the end of the previous pass. The 6 added are hand-wrapped files (Prettier rejected them at `HEAD`) that this pass edited for the first time. Prettier differs on none of the lines this pass changed. **Gap found:** the gate skips untracked files. This pass's new files are Prettier-clean; 15 untracked files from earlier passes are not |

**Widths and roles.**

- The owner on 21 screens, reception and the dentist on 19 each, at 320, 375, 390, 414, 768, 1024, 1280 and 1440 px: **0 horizontal overflow**.
- Super Admin: the console signs in and loads at 390 and 1440 px.

**Flows walked in the browser** (production build, demo clinic):

| Flow                                                                                       | Result                                                                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Taken slot                                                                                 | 409 from the database → "That time was just taken…", next free time offered                                        |
| Move + Undo                                                                                | moved, toast with Undo, restored                                                                                   |
| Check-in + Undo                                                                            | checked in, undone, confirmed                                                                                      |
| Search                                                                                     | services (Book it), actions, pages; accents and word order                                                         |
| Booking from a record, Move from a record                                                  | pass                                                                                                               |
| Chart → invoice → part payment (card) → second payment starts on card → paid → receipt PDF | pass                                                                                                               |
| Import, two files                                                                          | 6 found → 4 imported; 3 found → 3 imported, names split                                                            |
| Lab: Clinical notice → Fitted → Undo                                                       | **failed first (409), fixed**, then pass with confirmation                                                         |
| Lab page, order from a record                                                              | pass                                                                                                               |
| Message from a record (phone), balance from an invoice, invitation from recall             | pass, in Albanian, handed to WhatsApp and recorded                                                                 |
| Reorder by supplier                                                                        | pass                                                                                                               |
| Reports and Export                                                                         | pass                                                                                                               |
| Role permissions                                                                           | Reports "Owner access only" for others; lab write needs `lab:write`; route-coverage and matrix specs; `role.itest` |

---

## 17. Remaining gaps

1. **Invoice dates at midnight.** `issued_at` and ledger dates default to the database's `CURRENT_DATE` (UTC). An invoice created between 00:00 and 02:00 in Tirana is dated the day before. Clinics are closed then, but it is 16 call sites and deserves one focused change.
2. **Imaging:** no clinician on an image, only who uploaded it.
3. **The format gate skips untracked files.** It should include them (`git ls-files --others --exclude-standard`) so new files are checked before their first commit.
4. **Backups** are the provider's point-in-time recovery; a restore has not been rehearsed.
5. **Lab costs** are recorded on the order but not turned into an expense. The lab's bill is still entered as an expense (category Lab).
6. **Message language** is per clinic, not per patient (a patient from abroad gets the clinic's language).
7. **`PatientImportPage.tsx`** is hand-wrapped. Whole-file Prettier would rewrite 281 of its 554 lines, so this pass's edits follow its surrounding style.

---

## 18. Recommended next phase

1. **The evening summary for the owner.** Today's money, what needs attention tomorrow and lab work due, by email or WhatsApp. It is the one D in the audit, and it serves the owner who is not at the clinic.
2. **Clinic-day dates everywhere.** Close gap 1, and add a test that creates an invoice at 00:30 Tirana time.
3. **Lab cost to expense.** When lab work is fitted, offer "Record the lab's bill" as an expense (category Lab, amount prefilled), so the lab card and the books agree.
4. **The imaging clinician.** A "taken or read by" dentist on documents, defaulting to the patient's dentist.
5. **Rehearse a restore**, and make the format gate include untracked files.
6. **Orthodontic series helper**, if ortho clinics ask: book the next N visits every X weeks as independent appointments.
