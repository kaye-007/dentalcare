# DentalCare — experience elevation: what was done

Date: 2026-09-27 · Follows [EXPERIENCE_ELEVATION_AUDIT.md](./EXPERIENCE_ELEVATION_AUDIT.md) · Branch `preserve/pre-production-sept-9-18`, uncommitted

**The standard.** The product should feel better, not become bigger. No modules, no migrations and no dependencies were added.

**Scope agreed with the owner.** The Ink & Ember identity stays: colours, typefaces, the warm background, glass and radii. Noise that hurt hierarchy was cut. Every visual change is listed in §1 so any of them can be vetoed.

---

## 1. What was visually changed (the veto list)

| #   | Change                                                                                                                                                                                                                                                                   | Where it lives                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1   | **Finished states are quiet.** Completed, Paid, Closed, Balanced ("within tolerance") and In stock draw as a muted ✓ and a word, with no coloured fill. Exceptions keep their colour.                                                                                    | `StatusPill` kind `done` (`components/ui.tsx`, `drawer-text.ts`, `InventoryPage.tsx`); `.pill--done` in `polish.css` |
| 2   | **Summary strips are one card.** Total · Paid · Balance on an invoice, and the Reports totals, are one card divided by hairlines instead of three separate cards.                                                                                                        | `.sumstrip` in `polish.css`                                                                                          |
| 3   | **Medical history is one card.** Allergies, conditions and medications are three short sections of one card; an empty section is one quiet line. The severe-allergy banner is unchanged and still loud.                                                                  | `MedicalHistoryCard.tsx`, `.medsec` in `polish.css`                                                                  |
| 4   | **Needs attention** replaces the amber stock banner and the separate recall line: one quiet list under the day's figures, with a warning-coloured icon for stock only.                                                                                                   | `DashboardPage.tsx`, `.attention` in `polish.css`                                                                    |
| 5   | **Seen-today rows** in Clinical recede by tone and weight, not by 70 % opacity, which failed contrast.                                                                                                                                                                   | `polish.css`                                                                                                         |
| 6   | **Ledger entry pills** (patient account): a charge is neutral and a payment is a quiet ✓. They were blue and green on every row.                                                                                                                                         | `PatientLedgerCard.tsx`                                                                                              |
| 7   | **Calendar week, several dentists** (follow-up, §13.1): everyone's week is a list per day — time and the dentist's initials, then the patient's whole name — instead of blocks a third of a day column wide. A chip row picks one dentist and brings the time grid back. | `ReservationsPage.tsx` (`WeekAgenda`), `.weekagenda` and `.calwho` in `polish.css`                                   |
| 8   | **A reminder that went out is a quiet ✓ Sent**, like a paid invoice. Failed stays red; queued and sending keep their colour.                                                                                                                                             | `SEND_PILL` in `RemindersTab.tsx`                                                                                    |
| 9   | **"Scheduled" in the reminders list is plain text.** Only cancelled and no-show keep a pill.                                                                                                                                                                             | `RemindersTab.tsx`                                                                                                   |
| 10  | **Overview › Outstanding invoices:** an invoice under 61 days old shows its age as plain text; 61–90 days is amber and over 90 red. Before, every row had a blue pill.                                                                                                   | `FinancialsPage.tsx`                                                                                                 |
| 11  | **Expenses:** the category is plain words (it was a grey pill), and the void control is a quiet icon.                                                                                                                                                                    | `ExpensesPage.tsx`                                                                                                   |
| 12  | **Settings › Branding:** the brand colour is a swatch beside its hex code, as the markup intended. The form's `width: 100%` rule had stretched the picker into a colour bar across the card.                                                                             | `polish.css`                                                                                                         |
| 13  | **Messages › Send history:** the status filter is drawn like the reminders filter; it was the browser's own square select.                                                                                                                                               | `polish.css`                                                                                                         |
| 14  | **Patient account dates** read "25 Sept 2026", as on invoices and expenses. They were "25/09/2026".                                                                                                                                                                      | `PatientLedgerCard.tsx`                                                                                              |

Nothing else about colour, type, glass, bloom, shadows or radii changed.

## 2. Mobile improvements

**The dashboard puts decisions first.**

- At 390 px the owner's dashboard shows, in order: the day's four figures, then _Needs attention_, then only the visits still to happen. (The follow-up moved the month's money above the visits; see §13.3.)
- Finished visits that need nothing more fold into one line, "Show 12 finished visits". A completed visit still waiting for a bill stays in the list with its **Bill** button.
- Tomorrow's list shows five, then "Show all 17 for tomorrow".
- Before, the page was about 3,200 px long and the exceptions sat at the bottom.

**Patients.** Each row is the name, then "Next Fri 2 Oct, 09:45 · Owes 14,000 L". The phone number shows only when there is neither a visit nor a debt to report.

**Patient record.**

- Edit sits with the ⋯ menu in the top-right corner; before, it floated beside the photo.
- The medical history is one card.
- _Record access_ is folded.
- A note's × stays on the note's line instead of wrapping onto a line of its own.
- The record is about 470 px shorter.

**Money tables fit the phone** instead of scrolling inside their cards:

- **Invoice line items.** Every table had a 600 px minimum on phones, so the invoice's **Amount** column sat past the card's edge, reachable only by swiping inside the card. Tables that already drop columns on a phone no longer carry that minimum.
- **Invoices list:** Invoice · Patient · Balance, with the status under the balance.
- **Payments:** the method rides under the amount.
- **Patient account (ledger):** Date · Detail · Amount.
- On phones, the money lists drop the avatar.

**Inventory cards** carry one action (Stock in) instead of two, and a quiet ✓ In stock.

**Kept as it was:** the fixed compact header with the logo, the five-tab bar and safe areas. The audit found them right.

## 3. Desktop improvements

- **Patients:** the columns are Patient · Phone · Next visit · Balance, plus Status in the _All_ filter. Email, city and registration date are gone from the list; they are on the record.
- **Dashboard:** exceptions sit together under the figures, and the Today list is calm (one No-show stands out; thirteen quiet ✓).
- **Dental chart:** the header has one switch (Arch/Surfaces) plus "Adult · FDI ▾". The dentition and numbering toggles open from there. An empty perio section is one line instead of a 250 px illustration.
- **Inventory:**
  - The header reads "2 out of stock · 11 low · 41 in stock".
  - Each row shows **Stock in** only; **Stock out** is first in the row's menu.
  - Visible buttons go from about 160 to about 108 (one action plus the menu per row).
- **Invoices:** the header states the clinic's real outstanding (see §6). Settled rows read "—" and "✓ Paid".
- **Cash drawer:** past days drop the Flags column unless some day has a flag.
- **Calendar (week):** a block sharing a narrow column shows only the patient's name, wrapped between words, because the grid already gives the time. Before: "Lo… 09:…".
- **Tablet widths (761–1024 px):** money lists drop the issue date, the amount paid and the invoice number on a payment, instead of scrolling inside their card.

## 4. Navigation

The audit found the navigation model already right, so it is unchanged:

- **desktop:** seven sections in the sidebar, with section tabs only where a section has more than one page;
- **phone:** Home · Calendar · Patients · Clinical-or-Payments (by role) · More, fixed, with 52 px targets.

The one navigation change is inside the dashboard: exceptions are a single list of links to the place where each is handled.

## 5. Patient, clinical and payment

**Patient**

- The list now answers when they are next in and whether they owe.
- The record's side rail is Medical history, Contact & details, and a folded Record access.
- Record access is now fetched only when opened, so opening a record makes one fewer request.

**Clinical**

- The chart header is quieter.
- Seen-today rows are legible.
- Finished visits no longer compete with the next patient.

**Payment**

- The sheet was already amount → method → one button → receipt state, and is unchanged.
- The invoice around it now reads as one summary band, and on a phone its line items show their amounts.

## 6. Correctness fixes found on the way

- **Invoices header figure.** It read "200 in view · 419,500 L outstanding" while the clinic's outstanding was 758,500 L. It summed the 200 loaded rows and presented the total as the clinic's figure. It now reads the server's figure: "758,500 L outstanding across the clinic".
- **Invoice amount hidden on phones** (§2).
- **Contrast failure** in Clinical › Seen today (§1, #5).

## 7. API

This pass made one change, and it is read-only:

- The patient list (`GET /patients`) gained `nextAppointmentAt` and `balance` for the page's patients, in two grouped queries per page.
- They are **only included for roles that may see them**: `appointments:read` for the next visit, `invoices:read` for the balance. A hygienist's list has the next visit and no balance, and a test checks exactly that.

There is no schema change.

## 8. Accessibility

- **axe-core WCAG 2 A/AA: 0 violations**:
  - as the owner at 1440 px on dashboard, patients, record, chart, billing tab, week calendar, clinical, invoices, invoice, payments, drawer and inventory;
  - as reception at 390 px on dashboard, patients, invoices, payments, drawer, inventory and record;
  - as a dentist at 390 px on clinical and the dashboard.
- One real failure was found and fixed (Clinical contrast).
- New controls:
  - the Record access toggle is a button with `aria-expanded` / `aria-controls`;
  - "Show N finished visits" and "Show all … for tomorrow" are buttons with `aria-expanded`;
  - the Add buttons in Medical history name what they add ("Add an allergy");
  - "Nothing owed" has an accessible name where it shows as "—";
  - the chart's view options say their current state ("View options: adult, FDI numbering").
- Status is never colour alone: ✓ and words for finished states, words plus colour for exceptions.
- Motion: only the Record access chevron was added (it rotates, 120 ms), and reduced motion is honoured by the existing global rule.

## 9. Responsive verification

**Overflow audit, 0 at every width:**

- 17 routes as the owner at 320 / 375 / 390 / 414 / 768 / 1024 / 1280 / 1440 px;
- 6 routes as reception at 320 / 390 / 768 px.

The audit measures elements that extend past the viewport outside an intended scroller, so the page-level clip cannot hide a real overflow.

**Card-level check:** the daily money screens (invoices, payments, patient account, invoice, patients) fit their cards at 320, 375, 390, 414, 768 and 1024 px, with no sideways swipe inside a card.

**Still scrolling inside their card on phones** at the time: staff, expenses, the message history, the drawer's past days, and Overview's outstanding table. The follow-up converted all of them (§13.2).

## 10. Verification

| Check                      | Result                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck (all workspaces) | pass                                                                                                                                                                        |
| Lint                       | pass                                                                                                                                                                        |
| Unit tests                 | 722 passed (45 suites)                                                                                                                                                      |
| Integration tests          | **492 passed** (33 suites), including 2 new: the patient list's next visit and balance, and the hygienist's list without balance                                            |
| Build                      | pass; main chunk 333 kB (105 kB gzip), up 1 kB                                                                                                                              |
| Cloudflare dry-run         | pass: 3,623 KiB / 943 KiB gzip                                                                                                                                              |
| Format gate                | 44 files. Of this pass's files, only `patients.service.ts`, which was already hand-wrapped in `HEAD`. Everything else this pass touched and could format is Prettier-clean. |

Everything ran against the isolated stack (throwaway Postgres on :55432, API on :3100, production web build on :5197). Your own API (:3000) and database (:5432) were not touched.

## 11. Deliberately left unchanged

- **Ink & Ember:** the palette, typography, glass, bloom and radii.
- **The phone shell and the navigation model** (§4).
- **The payment sheet and the cash drawer's open card.** They were already the shape the brief describes.
- **The payment amount field** shows "20000 L" while typing, without a group separator. Formatting a number under the cursor fights the person typing.
- **Settings** keeps its grouped side list; the audit found it organised by human concepts already.
- **Control Center:** one clinic, reworked in an earlier pass.

## 12. Remaining issues

Items 1–4 of the first list (the dense week, the brand-colour bar, the secondary tables and the owner's money on a phone) were closed by the follow-up in §13. Left open:

1. **Carried from earlier passes:** calendar drag-to-move, the chart not passing `appointmentId`, and the production-demo decisions in [PRODUCT_POLISH_COMPLETE.md §7](./PRODUCT_POLISH_COMPLETE.md).
2. **The VAT report's default period follows the server's clock** (API; found by the follow-up's test run and not changed). `defaultRange()` in `reports.service.ts` ends at the server's local date, while an invoice carries the clinic's date. From the clinic's midnight until the server's, today's invoices fall outside the default period: 00:00–02:00 in Tirana on a UTC server, or the whole evening on a laptop in New York. This is what failed `checkout.itest.ts › TVSH reporting` at 23:09 New York time. With the process on the clinic's timezone, all 492 integration tests pass. The fix is the clinic-timezone period that `/finance/summary` already uses.
3. **Send history shows times on the device's clock**, not the clinic's (`when()` in `HistoryTab.tsx`). It reads the same for staff in Albania, and wrong for anyone looking from elsewhere.
4. **Send history between 1081 and 1179 px:** the eight-column desktop table is 11–30 px wider than its card and scrolls inside its own scroller. Template and Sent by repeat on every row what the send above already says.

## 13. Follow-up: the remaining issues closed

Date: 2026-09-27, evening · Same branch, uncommitted · No API, schema or dependency change.

Scope as asked: the four remaining issues and a last consistency pass, with no features and nothing the audit called right redesigned. The Ink & Ember identity is unchanged. The new visual changes are rows 7–14 of the veto list in §1.

### 13.1 Calendar week with several dentists

**Everyone** (the default when the clinic has more than one practitioner) is now a list per day instead of a time grid:

- Each booking shows its time and the dentist's initials, then the patient's whole name. The name has a line of its own, so at 1280 px it is "Esmeralda Kurti", not "Esmer…".
- The room colour is the left edge, as on the grid.
- The exceptions look the way the grid draws them: waiting is outlined, in the chair is amber, a no-show is dashed, a cancellation is struck through. A seen visit recedes by tone and weight.
- A day's heading still opens that day. The Day view, with a column per dentist, stays the working view.

**One dentist:** a chip row, "Everyone · Dr. Ardit Hoxha · Dr. Elira Dervishi · Dr. Besnik Kola", sits over the week. Choosing a dentist brings the time grid back with blocks the full width of the day. It is the same filter as Filters › Practitioner.

**Narrow screens:**

- Up to 1080 px, the list becomes a day per row, with the bookings flowing across it.
- On a phone, each day is a heading over its list, one booking per 40 px line.
- An empty week no longer says "click any open time slot" when there is no grid to click.

### 13.2 Secondary tables on phones and tablets

Each table keeps the columns a row needs. The rest ride as a sub-line: `.only-sm` on phones, `.show-md` on tablets. Nothing scrolls sideways inside a card.

| Screen                  | Phone                                                                                                 | Tablet (761–1080 px)                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Staff                   | Person, with "Dentist · two-step off" under the name                                                  | Drops Sees patients and Two-step                                                            |
| Expenses                | Note, with "Lab · 25 Sept 2026" under it · Amount. The date no longer wraps over three lines          | The phone layout                                                                            |
| Cash drawer › Past days | Day (and who ran it) · Result. A day not yet counted shows its state, and flags ride under the result | Drops the Drawer column                                                                     |
| Overview › Outstanding  | Patient (with the invoice number) · Balance · Age                                                     | Drops Issued and Paid                                                                       |
| Messages › Reminders    | Patient, with "09:00 · No WhatsApp consent" · Reminder. The filter spans the row                      | Drops number, time and reason                                                               |
| Messages › Send history | Patient (with the appointment) · Status, with the failure reason under it                             | Patient · Status · Failure reason                                                           |
| Services & prices       | The phone list, unchanged                                                                             | Visits, TVSH and Status fold under the name. The edit button is back inside the card        |
| Inventory               | The stock cards, unchanged                                                                            | Minimum, category and stock state fold under the item. **Stock in** is back inside the card |

The tablet range is now 761–1080 px, the line `styles.css` uses everywhere else. It was 761–1024 px, which left 1025–1065 px with the inventory's actions past the card's edge.

### 13.3 The owner's money on phones and tablets

- Wherever the dashboard is one column (up to 1080 px), the owner sees **This month** and **Awaiting payment** straight after _Needs attention_. Today's visits and Coming up follow.
- On a 26-visit morning at 390 px, the month now starts about 580 px from the top. It had been below all 26 visits, more than 2,300 px down.
- The day's four figures are two by two up to 1080 px. Four across on a tablet had cut them to "614,5…" and "20,00…".
- Reception and the dentists keep their order; desktop is unchanged.

### 13.4 Consistency pass

- **Quiet states** reached the screens the first pass had not: reminders that went out, a "Scheduled" appointment in the reminders list, and a young receivable (rows 8–10 in §1).
- **Controls** now look the same as elsewhere:
  - the brand-colour swatch;
  - Send history's filter;
  - the reminders filter on a phone;
  - on a tablet, the top bar no longer clips the section name ("Settin") under the search box.
- **Stylesheet:** the week list, the table sub-lines and the tablet rules are one ordered section each in `polish.css`. Two leftovers were removed: a global `.hide-md !important` that repeated `.table .hide-md` (every use is in a table), and a 360 px date-wrap rule that no longer had anything to wrap.

### 13.5 Verification

Everything ran against the isolated stack: throwaway Postgres on :55432, API on :3100, and the production web build on :5197. Your API (:3000) and database (:5432) were not touched. Sample WhatsApp sends were added to the throwaway demo database only, so that Send history had rows to lay out.

| Check                      | Result                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck (all workspaces) | pass                                                                                                                                                                                                                                                                |
| Lint                       | pass                                                                                                                                                                                                                                                                |
| Unit tests                 | 722 passed (45 suites)                                                                                                                                                                                                                                              |
| Integration tests          | 492 passed (33 suites) with the process on the clinic's timezone (`TZ=Europe/Tirane`). On the machine's own clock at 23:09 New York time, 1 failed: `checkout.itest.ts › TVSH reporting`, the server-clock issue in §12 item 2. This follow-up changed no API code. |
| Build                      | pass; main chunk 333 kB (105 kB gzip), unchanged                                                                                                                                                                                                                    |
| Cloudflare dry-run         | pass: API 3,622.64 KiB / 942.73 KiB gzip; the tenant-web and admin-web workers 0.33 KiB each                                                                                                                                                                        |
| Format gate                | 44 files: the same 44 as before the follow-up. Every file it touched that Prettier formats is clean. In the three hand-wrapped CRLF pages it edited (`ReservationsPage`, `CashDrawerPage`, `StaffPage`), Prettier differs on no line the follow-up changed.         |
| Overflow audit             | 0 of 198 (owner: 22 routes × 9 widths, 320–1440 px) and 0 of 36 (reception: 9 routes × 4 widths)                                                                                                                                                                    |
| Card-level fit             | The dashboard, the week and the 13 table screens fit their cards at 320, 375, 390, 414, 768, 834, 1024, 1050, 1080, 1180 and 1280 px; every other route fits at 390 and 768 px. The one exception is Send history at 1081 and 1100 px (§12 item 4).                 |
| axe-core WCAG 2 A/AA       | 0 violations in 36 runs (owner at 1440, 1280, 1080, 768 and 390 px; reception at 768 px)                                                                                                                                                                            |
