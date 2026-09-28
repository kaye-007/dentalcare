# DentalCare — product experience audit

Date: 2026-09-27 · Follows [PRE_LAUNCH_PRODUCT_POLISH.md](./PRE_LAUNCH_PRODUCT_POLISH.md) and [UI_UX_IMPLEMENTATION.md](./UI_UX_IMPLEMENTATION.md)

**The question this audit answers:** the twenty things a clinic does every day. Which are already easy, which are nearly there, and which still make people think about the software?

**Constraints kept:**

- The visual language ("Ink & Ember": glass, bloom, radii, colours) stays as it is. This pass improves workflow, hierarchy and structure only. It does not restyle.
- The demo clinic stays **DEMO**. Its data is in Albanian and the UI is in English, as the owner decided on 2026-09-27.

---

## 1. What already exists

Two earlier passes (2026-09-26 and 2026-09-27) already did most of what a "basics done well" brief asks for. The inventory, by area:

| Area                | What is there                                                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell & navigation  | Seven sections (Dashboard · Calendar · Patients · Clinical · Payments · Reports · Settings) from one map (`lib/navigation.ts`); section tabs only when there is more than one page; breadcrumb                                                                    |
| Phone shell         | Fixed brand header, in-place search overlay, five-tab bottom bar with a role-aware fourth tab, _More_ as the full menu, `html/body/.content` clip horizontal overflow; 0 overflowing routes at 320–1440 px                                                        |
| Search              | Top-bar search, `/` and Ctrl/⌘ K; patients by name, surname, phone (digit-wise, with or without 0/+355), email, national ID; invoice numbers for staff who can read invoices                                                                                      |
| Patient record      | Header with allergy flag, four primary actions (Appointment · Clinical note · Treatment · Payment), _More_ for the rest; facts row (phone · next · last · balance); one History timeline (visits, notes, charges, payments); tabs for chart, plans, billing, docs |
| Booking             | Patient → what for → practitioner → date → free-time chips → room; double-booking and room warnings; new patient inline; "Book for 14:30"                                                                                                                         |
| Calendar            | Day · Week · Month · List (List is the phone default); practitioner chips; Call / Check in / Bill on list rows                                                                                                                                                    |
| Clinical            | Clinical › Today with a hero card for the next patient and one forward step through the state machine; odontogram (arch + surfaces, FDI/Universal, adult/paediatric) with in-place tooth records; perio charting; treatment plans with estimates                  |
| Payments            | Payment sheet: amount → method (segmented) → one button; the document is the clinic default ("Change" only when there is a choice); success turns into a receipt; drawer closed → start the day in the sheet                                                      |
| Fiscalization       | Full CIS integration (0010/0015): dual-mode checkout (internal/fiscal), retry queue, QR, TVSH report, Fiscalization page                                                                                                                                          |
| Cash drawer         | Start with float → expected figure → close with count, difference by band, note/approval rules; hash-chained events; blind count option                                                                                                                           |
| Messaging           | Appointment reminders (log / SMS / WhatsApp Cloud), WhatsApp templates and connection, two-way Messages screen                                                                                                                                                    |
| Inventory           | Items with status words, Stock in / Stock out per row, lots and expiry, _More_ per row; phone cards                                                                                                                                                               |
| Import              | CSV upload → auto-guessed column mapping → review with problems and duplicates (in file, and against existing patients by phone / national ID) → import                                                                                                           |
| Dashboard           | One lens per role: desk (today, coming up, who owes), clinician (own column, counts), owner (today + this month + owes), accountant (money only)                                                                                                                  |
| Settings            | Grouped side list (Clinic · Payments · Communication · System); phone gets a settings list                                                                                                                                                                        |
| Control Center      | Overview (needs attention first), clinics, billing, usage, plans, activity                                                                                                                                                                                        |
| Accessibility, perf | axe WCAG A/AA 0 violations on the checked routes; reduced motion honoured; route-level code splitting (main chunk 327 kB)                                                                                                                                         |

## 2. What already works well

- **The payment sheet.** It is already amount → method → button, with a receipt state. It needs no redesign.
- **The cash drawer.** It is the three-state model the brief describes (Start day / Expected / Count → Difference → Balanced).
- **The phone shell.** It has a fixed header with the logo, a bottom tab bar, no sideways page scroll, and tables that turn into cards.
- **Booking.** Free-time chips and "next open day" already make a booking a handful of taps.
- **Search.** Phone numbers match however they are typed, which is the most common desk search.
- **Error language, loading skeletons, toasts and confirm dialogs.** They are consistent across the app.

## 3. What is incomplete

Found in the code, not assumed:

1. **Bill → invoice starts empty.** The dentist records what was done on the chart (`clinical_procedures`, with fee, tooth and service). But **Bill** opens a blank new-invoice form, and the receptionist re-enters the same services by hand.
   - The ad-hoc invoice path cannot link a line to the procedure it bills (`invoice_line_items.procedure_id` exists, but only the demo seed fills it).
   - So nothing stops the same work from being billed twice.
   - This is the biggest break in the core loop: _clinical work → treatment → payment_.
2. **Recall does not exist.**
   - There is no "patients due for a check-up" anywhere. The only "recall" in the code is for inventory lots.
   - A clinic's recall list is how empty chairs get filled. Today it lives on paper.
3. **The owner cannot see today's money.**
   - The owner dashboard shows _This month_ (collected, expenses, profit), but not today's takings or the drawer's state.
   - `/finance/summary` only knows `month` and `all`.
   - Its month boundary is also computed on the database's clock (UTC), not the clinic's (Europe/Tirane), so a payment at 00:30 on the 1st lands in the previous month.
4. **Excel import.** Import accepts `.csv` only. Albanian clinics keep their patient lists in Excel, so the first step of switching is "open Excel, Save As CSV", which is exactly the kind of instruction that loses people.
5. **Open invoices on the record are found by name.**
   - The record asks `/invoices?q=First Last` and filters on the client.
   - The list is capped at 200 rows, newest first, so an older open invoice can fall off.
   - Two patients with the same name make it fetch the other's invoices too.
   - The dashboard's _Awaiting payment_ card has the same cap.

## 4. What is unnecessarily complicated

- **The fiscal panel on an invoice** shows NIVF, NSLF, business unit, TCR code and operator code up front, and the header pill reads "Fiscal · awaiting NIVF". A receptionist needs one of three states: _Fiscalized_, _Pending_ or _Needs attention_. The codes matter to an accountant or an inspector, and should be one click away.
- **Calendar blocks** still show a "Scheduled" pill on every booking. The default state should be silent; only the exceptions (checked in, in the chair, done, no-show, cancelled) should speak. The list views already do this.
- **Search** offers "See all patients matching …" when only invoices matched.

## 5. What should be simplified

- **Fiscal status:** three plain words, one icon. The codes go behind a disclosure.
- **The Bill step:** if the chart already says what was done, the invoice should say it too. The receptionist confirms and takes payment.
- **Owner pages reached by URL** (`/financials`, `/reports`, `/activity`) as a receptionist render empty pages full of 403s. They should say plainly that the page is for administrators, as Settings already does.

## 6. What should be combined

- **Chart → invoice.** Unbilled completed procedures appear as the invoice's lines. This is one flow, not two data-entry passes.
- **Recall + booking.** A recall row carries _Call_ and _Book_. Booking opens the existing panel with the patient filled in. There is no separate recall "campaign" screen.

## 7. What should be hidden behind progressive disclosure

- Fiscal identifiers (NIVF, NSLF, TCR, operator, last error) go under _Fiscal details_.
- The recall interval: six months by default, with a choice of 3 / 6 / 12 months on the recall list itself. It is not a new settings page.
- Everything already behind _More_ on the patient, invoice and inventory rows stays there.

## 8. What should become a primary action

| Screen                      | Primary action                                                              |
| --------------------------- | --------------------------------------------------------------------------- |
| New invoice (from **Bill**) | **Create invoice** with the chart's lines already on it → payment           |
| Recall list                 | **Book** on each row (Call secondary)                                       |
| Owner dashboard             | Unchanged (_New appointment_); _Today_ figures are information, not actions |

## 9. Existing features to elevate instead of rebuild

| Feature                            | Elevation                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `clinical_procedures` + invoices   | Link lines to procedures (`procedureId`), server-validated, so work is billed once. Pre-fill **Bill** from the chart.                |
| `/finance/summary`                 | Add `today`, and compute both periods on the clinic's clock                                                                          |
| `/invoices`                        | Add a `patientId` filter; the record and the dashboard use it                                                                        |
| Appointments + patients            | A derived recall list: no new table, no new schema                                                                                   |
| Import                             | Read `.xlsx` in the browser with the platform's own `DecompressionStream`, with no new dependency. The rest of the flow is unchanged |
| Fiscal panel                       | Plain status + disclosure; no change to fiscal behaviour                                                                             |
| Calendar blocks, search, 403 pages | Small, targeted fixes                                                                                                                |

## 10. Deliberately not planned

Each was considered and rejected against "does this make a core dental workflow substantially easier?":

- **Drag-to-move on the calendar week grid.** Worth doing, but it needs a server-side move endpoint with practitioner and room conflict checks returned before the drop settles. A drag that can silently double-book is worse than the panel. It is recorded as the next step, not faked on the client.
- **Automated recall messages, and post-treatment follow-up messages.** WhatsApp Business only allows business-initiated messages through approved templates, per clinic. The template and consent machinery exists for reminders, but a recall template would need each clinic's approval first. The recall list with _Call_ and _Book_ is useful on day one; automation can follow once a template exists.
- **Appointment confirmation messages.** The same template constraint applies.
- **Treatment "journeys"** (implant → healing → restoration as a workflow builder). Treatment plans already sequence multi-visit work, and the brief itself warns against an enterprise workflow builder.
- **A general search engine** across appointments and treatments. Both are reached through the patient, who is always what people search for first.
- **Any restyle.** It was excluded by the owner.
