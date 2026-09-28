# DentalCare — the simplicity pass

Date: 2026-09-28 · Follows [EXPERIENCE_ELEVATION_COMPLETE.md](./EXPERIENCE_ELEVATION_COMPLETE.md) · Branch `preserve/pre-production-sept-9-18`, uncommitted

**The standard.** Keep the power; remove the effort of using it. Nothing was removed from DentalCare and nothing was hidden for good. What changed is how much a person has to decide at once, and how much the system works out for them.

**Where the work went.** Earlier passes had already built the role dashboards, the patient header with its four actions, the payment sheet, the grouped settings and the Ctrl/⌘+K search. The audit for this pass found one large gap and a few small ones:

- **The large gap was the appointment.** Booking meant choosing a day, then a time, then a dentist, then a room, and working out availability by eye. The panel also said "save anyway" about a double-booked dentist, which the database always refuses.
- **The small ones:**
  - no way to undo a mistaken check-in;
  - no "move this visit" shortcut;
  - the clinic's own visit length was ignored;
  - search did not forgive a missing ë or ç, or a surname typed first.

The visual identity (Ink & Ember) is unchanged. Every visual change is listed in §1 so any of them can be vetoed.

---

## 1. What was visually changed (the veto list)

| #   | Change                                                                                                                                                                                                                                   | Where it lives                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | **Booking panel.** Three numbered steps (Patient, What for, When). A finished step folds to one line with **Change**. Free times are rows (time · dentist · room) grouped under Today, Tomorrow, Friday 2 October. Services are a list with length and price. | `AppointmentModal.tsx`; `.step--folded`, `.slot`, `.svcrow` in `polish.css` |
| 2   | **Dentist chips** above the times: First available, then the patient's own dentist with a small "usual" tag, then the others.                                                                                                            | `.finder__who`, `.chip__tag`                                      |
| 3   | **An existing visit** opens on one filled button, its next step (Check in, Start treatment, Complete or Reinstate), then **Move**, then **⋯** for the rest. The footer button is **Done**.                                                                 | `AppointmentModal.tsx` (`VisitPanel`), `.visit__do`               |
| 4   | **Toasts can carry an action**, a pill-shaped **Undo** or **View** button on the dark toast.                                                                                                                                             | `ui.tsx` (`ToastView`), `.toast__action`                          |
| 5   | **"Waiting 12 min"** on a checked-in patient's row (dashboard and calendar list), amber from 20 minutes. It replaces the plain "Checked in" pill.                                                                                          | `WaitingPill.tsx`                                                  |
| 6   | **Search results come in groups**: patients, then Services, Actions and Go to, each with a small uppercase label. A patient's second line shows their next visit when they have one.                                                     | `AppLayout.tsx`, `.gsearch__group`                                |
| 7   | **Patient header**: a **Move** link beside the next appointment. The **Clinical note** button is now **Note**.                                                                                                                           | `PatientProfilePage.tsx`, `.profile__move`                        |
| 8   | **Financials opens on Today**: Collected · Spent · Net · Outstanding in one strip, above the period figures, which now carry a small period label.                                                                                        | `FinancialsPage.tsx`, `.fin__label`                               |
| 9   | **Owner's "Collected today" tile** has a note: "5,000 L spent · 40,000 L net" (only when something was spent).                                                                                                                            | `DashboardPage.tsx`                                               |
| 10  | **Severe-allergy banner**: its detail line is full strength. It was faded to 90 % and failed contrast.                                                                                                                                    | `polish.css`                                                      |
| 11  | **Wording** (see §6): Book appointment, Add stock / Use stock, Pay / Paid.                                                                                                                                                              | `strings.ts`, `InvoiceDetailPage.tsx`                             |

Nothing else about colour, type, glass, bloom, shadows or radii changed. The new styles are one section at the end of `polish.css` and use the existing tokens only.

## 2. Appointments

### 2.1 The flow

**Before.** A form with Patient, a Service dropdown, Reason, Practitioner, Date, Start time, a row of time chips for that one day, Length and Room. The receptionist picked a day, then looked for a gap.

**Now:**

- **Patient**, then **What for** (tap a service: its length comes with it), then **When**: a list of times that will actually book, each with the dentist and room already chosen.
  - Today 16:30 · Dr. Ardit Hoxha · Salla 1
  - Tomorrow 09:00 · …
- Then **Book for 16:30**.
- Each finished step folds to one line with **Change**, so the three lines are the confirmation: who, what for, when, with whom, where.
- **Details** (folded) still holds every field: the exact date and start time, the length, the dentist (including Unassigned), the room (including No room) and the wording of the reason.

Measured on the demo clinic at 390 px: dashboard → **Book appointment** → type "Erisa" → pick her → tap Abatment → tap the first time → **Book**. That is 5 taps and 5 letters. Focus follows each step, so it is the same with a keyboard.

### 2.2 Find a time

- A new endpoint, `GET /api/appointments/find-times`, does the arithmetic the desk used to do by eye.
- Its rules live in `find-times.ts`: pure functions, no database, next to the status machine, with 16 unit tests.

**What it considers:**

- each dentist's own weekly shifts; the clinic's opening hours for anyone without shifts;
- holidays and a dentist's leave (closures);
- everything already booked for the dentist, the room and **the patient**. These are the three conflicts the database refuses, so an offered time books unless someone takes it first;
- the service's length, the quarter hour, and nothing that starts in the next five minutes;
- the room: the dentist's home room first, then any free room. A clinic with rooms is never offered a time with no free room.

**What it offers:**

- **Soonest**: the first free time of the morning, of midday (12:00) and of the afternoon (15:00), day by day. That is how the question is answered on the phone: "tomorrow at nine, at twelve, or at three?" **More times** carries on where it stopped.
- **Choose a day**: every free start on one day.

**Who it offers them with:**

- The patient's own dentist is preselected, meaning whoever saw them last. **First available** is one tap away.
- When several dentists are free at the same moment, the patient's own dentist is offered first, then whoever has the lightest day.

### 2.3 Move (reschedule)

- An appointment now opens on its next step with **Move** beside it. So the path is: appointment → **Move** → the same list of free times → tap. It is done, with no edit form.
- The list leaves the visit itself out of the conflicts, and does not offer its current slot back.
- **Move** is also on the patient's record, beside the next appointment.
- The toast says "Moved Florian Bushati to Tomorrow, 09:30" with **Undo**. Undo puts back the time, the dentist and the room. If the old slot was taken meanwhile, the toast says so.

### 2.4 Double booking

- When the chosen time is taken between choosing and booking (another desk, a second tab), the panel says **"That time was just taken. Here are the next free times."** The time is cleared and a fresh list is shown in the same place.
- If the patient is the conflict, it says so in those words.
- The API now answers conflicts with a code the screen can act on: `slot_taken` (dentist or room) or `patient_busy`. The messages are unchanged.
- Tested live: an appointment was created for the same dentist and time through the API mid-booking. The panel answered with the sentence above and a list starting an hour later.

**Fixed along the way.** The old panel told staff a double-booked dentist "can save anyway if the overlap is intended". The database has always refused it (`appointment_no_staff_overlap`), so that advice led straight to an error. Typed-in conflicts now say who is in the way and offer **Find a free time**, or **Use Salla 2** for a taken room. A closure is the one thing the clinic may still knowingly book through, and it says so.

### 2.5 One way in, from everywhere

**Book appointment** opens the same panel over the page you are on. It no longer sends you to the calendar and back. It opens from:

- the dashboard;
- the **New** menu;
- a patient's record (the patient is known);
- the recall list (booking takes the patient off it at once);
- search (a service found in search opens the panel with that service chosen);
- the calendar;
- an empty calendar slot (time, dentist and room are known: only patient and service are asked).

`/reservations?new=1` still works for old links. After a booking made away from the calendar, the toast offers **View**, which opens that day.

## 3. What became automatic

- **Availability**: working hours, leave, holidays, other bookings, rooms and the patient's own diary (§2.2).
- **The room**, chosen with the time.
- **Recovery from a taken time**: fresh times appear where the error is.
- **The waiting room**: how long each checked-in patient has waited, counted on the rows.
- **The owner's day**: what went out beside what came in, and net.

## 4. Smart defaults (all editable)

| Default                            | Before                           | Now                                                                          |
| ---------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| Visit length                       | Always 45 min in the panel       | The clinic's setting (Settings › Opening hours › Visit length); a service's own length once chosen |
| Dentist                            | Unassigned, or the column clicked | The patient's own dentist (who saw them last); the column clicked still wins |
| Room                               | The dentist's home room          | The same, now also inside the suggested times, with a free room when it is taken |
| Day                                | Today                            | The day the calendar was showing, when it is later than today                |
| Service → reason and length        | Filled from the catalogue        | Unchanged                                                                    |

## 5. What became contextual (three layers)

| Screen             | Level 1: now                                   | Level 2: in context                        | Level 3: still there, folded                 |
| ------------------ | ---------------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| Booking            | Patient · What for · When · Book               | Change on each step; dentist chips; Choose a day; More times | Details: exact time, length, dentist, room, reason |
| A visit            | Its next step                                  | Move                                       | ⋯ (No-show, Cancel, Complete, Undo check-in…), Details, History |
| Patient            | Appointment · Note · Treatment · Payment       | Move beside the next visit                 | ⋯ (Archive), tabs                            |
| Search             | Patients                                       | Invoices by number                         | Services, actions, pages                     |
| Financials         | Today                                          | The chosen period                          | Charts and breakdowns below                  |

## 6. One action language

| Action                  | Before                                                                    | Now                          |
| ----------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| Create an appointment   | "New appointment", "Book appointment", "Book an appointment", "Appointment" | **Book appointment** (and "Appointment" beside the patient's other actions) |
| Status steps            | "→ Mark checked in", "Mark in progress", "Mark completed", "Mark scheduled" | **Check in**, **Start treatment**, **Complete**, **Reinstate**, **Undo check-in** |
| Reschedule              | Edit the form                                                             | **Move**                      |
| Take money              | "Take payment" → "Take 3,500 L" → "Payment received"                     | **Pay** → **Pay 3,500 L** → **Paid** |
| Stock                   | "Stock in" / "Stock out"                                                  | **Add stock** / **Use stock**  |
| Close a panel that saves itself | "Close"                                                           | **Done**                      |

**Button discipline:**

- A visit shows one primary button, where there were up to five status buttons of equal weight.
- The booking panel has one primary button (Book).
- Each dentist's time is one row. Before, a row of 12 chips sat beside four other fields.

## 7. Patient

- **Who, next, what happened, what they owe** was already the header. It gained **Move** beside the next visit.
- **Appointment** books over the record, with the patient known, and the record refreshes afterwards.
- **Note** is the button's name now (it was "Clinical note").

**Search is more forgiving** (server side, so the patient list and every picker gain it too):

- **Without accents**: "cela" finds Anxhela Çela; "hoxhe" finds Hoxhë.
- **In either order**: "Çela Anxhela" or "maria hox" (a later given name).
- By name, phone (as before, digits only), email, or **ID**. The national ID number is the patient ID the clinic has. The search box now says so: "Search patients by name, phone or ID…".

## 8. Role by role

**Receptionist**

- Today's list counts the room: "28 appointments · 2 waiting · 1 in the chair · 25 still to arrive".
- Each waiting patient shows how long they have waited.
- Check in has **Undo**. It was irreversible, so checking in the wrong namesake had no fix.
- Book, Move and Pay are each one step from the row or the record.

**Dentist**

- Unchanged in shape: their own patients today, with Clinical as the primary action.
- Anyone who may book gets the same panel and the same free times.

**Owner**

- Today at a glance, as before. "Collected today" now says what was spent and the net.
- **Financials opens on Today** (Collected · Spent · Net · Outstanding). The 30-day to 12-month figures, the charts and the breakdowns follow.

**Super Admin (console)**

- Not changed. It was signed into at 390 and 1440 px after this pass and loads its overview with no failed requests.

## 9. Search and command (Ctrl/⌘+K or "/")

The same box, still patients first. Under them, for whoever moves fast:

- **Services**, with length and price, answer "how much, how long?" on the spot. Choosing one opens the booking panel with it chosen.
- **Actions**: Book appointment, Add patient, New invoice, Add expense. Only what the role may do is offered, and nothing is offered on a read-only trial.
- **Go to**: any page the role may open. It also matches the words people use:
  - in English: stock → Inventory, cash → Cash drawer;
  - in Albanian: arka, fatura, fisk…, stoku, pagesa.

Services and pages match the start of a word, so "ka" finds "Trajtim kanali", not every word containing "ka".

## 10. Undo instead of "Are you sure?"

| Action                            | Undo does                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| Check in (dashboard, calendar list, visit) | Back to Scheduled                                                                 |
| No-show, Cancel (from Scheduled)   | Back to Scheduled; the database re-checks that the slot is still free                         |
| No-show, Cancel (from Checked in)  | Back to Scheduled, then Checked in                                                           |
| Move                               | Back to the old time, dentist and room                                                        |

A toast with an action stays 8 seconds. It waits while the pointer or keyboard focus is on it.

**Kept as confirmations**, because they are destructive:

- delete a document;
- delete a WhatsApp template;
- disconnect WhatsApp;
- remove a room;
- void a payment or an expense;
- archive a patient (the dialog records the reason).

**One rule changed to allow this: a check-in can be taken back.**

- `status-machine.ts` now allows `checked_in → scheduled`. The existing transition code already clears `checked_in_at` on the way back to Scheduled.
- The step is recorded in the status history like any other.
- Treatment that has started still cannot be taken back, and Completed is still final.

## 11. Payments, fiscalization, inventory, settings

- **Payments.** The sheet was already amount → method → one button → receipt. Only the words changed (§6).
- **Fiscalization.** Not touched: no request, retry, document choice or identifier changed.
- **Inventory.** Already opens on "2 out of stock · 11 low · 41 in stock" with one action per row. Only the words changed.
- **Settings.** Already grouped into Clinic, Payments, Communication and System, with Staff, Rooms, Services and WhatsApp linked from there. Left as it is.

## 12. Mobile and desktop

**Phone**

- The panel is a full-screen sheet.
- A finished step takes one line, so the three answers and the Book button fit on one screen at 390 px.
- Dentist chips scroll sideways, and the chosen one is kept in view.
- Time rows are 52 px targets.
- Below 400 px, the dentist and room wrap to a second line instead of being cut off.

**Desktop**

- The panel docks beside the page it was opened from.
- The dentist chips wrap, so every dentist is in sight.
- The Visit panel keeps the calendar visible beside it while moving.

**No horizontal overflow anywhere** (§15). The booking and visit panels are fixed overlays that the page-level audit skips, so they were audited on their own at every width.

## 13. Accessibility

- **axe-core WCAG 2 A/AA: 0 violations**:
  - on 16 routes across three roles;
  - on every booking and visit state at 390 and 1440 px;
  - on the open search list and on a toast with Undo.
- **One real failure found and fixed**: the severe-allergy banner's detail line (§1, #10). It predates this pass.
- **Focus follows the flow:**
  - the booking panel opens in the patient search;
  - each finished step moves focus to the next step's heading;
  - once everything is chosen, focus is on **Book for 09:45**.
- **Names and states:**
  - each time is a button named in full ("Tomorrow, 10:30, Dr. Ardit Hoxha · Salla 1") and pressed-state aware;
  - "Change" buttons name what they change;
  - dentist chips are pressed-state buttons.
- The toast's action is a real button, focusable, and the toast waits while it has focus.
- Motion is limited to state changes (a selected time, a new step), and reduced motion is honoured by the existing global rule.

## 14. What was preserved

Nothing was removed.

**Appointments**

- Every field of an appointment is still editable: patient, reason, practitioner or Unassigned, exact date and time, any length, room or No room.
- A booking whose dentist no longer sees patients keeps them.
- A booking whose room was archived keeps it.
- Cancelling still requires a reason.
- History is still one tap away.

**Everything else is untouched:**

- tenant isolation (RLS), permissions, the status machine's other rules;
- the EXCLUDE constraints (still the authority on conflicts);
- fiscalization, the cash drawer, money and inventory;
- clinical records;
- WhatsApp, imports and exports;
- the console.

**No database migration**, and no new dependency.

## 15. Verification

Everything ran against the isolated stack:

- a throwaway Postgres on :55432, with `dentalcare_demo` reseeded for today and `dentalcare_itest`;
- the API on :3100;
- the production web build on :5197;
- the console build on :5196.

Your API (:3000) and database (:5432) were not touched.

| Check                      | Result                                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck (all workspaces) | pass                                                                                                                                                                                                                              |
| Lint                       | pass, no warnings                                                                                                                                                                                                                 |
| Unit tests                 | **739 passed** (46 suites), was 722. New: 16 for find-times, 1 for undoing a check-in                                                                                                                                              |
| Integration tests          | **504 passed** (34 suites), was 492. New: `find-times.itest.ts` (10), and 2 search cases (accents, word order). Run with `TZ=Europe/Tirane`, as before                                                                             |
| Build                      | pass. Main chunk 338.8 kB (106.8 kB gzip), up 5.8 kB (search, the booking entry point, toast actions). The booking panel is its own 30.7 kB chunk (10.3 kB gzip), shared by the calendar and every other entry point |
| Cloudflare dry-run         | pass. API 3,631.6 KiB / 946.5 KiB gzip (up 9 KiB); tenant-web and admin-web 0.33 KiB each                                                                                                                                          |
| Format gate                | 46 files, was 44. See the note below the table                                                                                                                                                                                    |
| Page overflow              | **0** of 270: owner 19 routes × 8 widths (320, 375, 390, 414, 768, 1024, 1280, 1440); reception 11 × 8; dentist 6 × 5                                                                                                             |
| Panel overflow             | **0** of 48: 6 booking and visit states × 8 widths                                                                                                                                                                                |
| axe WCAG 2 A/AA            | **0** after the one fix (§13)                                                                                                                                                                                                     |

**Format gate note.** Every new file, and every file Prettier accepted before this pass, is Prettier-clean. `AppointmentModal.tsx` left the list. The three that joined it are hand-wrapped API files that Prettier already rejected at `HEAD`, and they now carry small edits in the surrounding style:

- `appointments.service.ts`;
- `status-machine.ts`;
- `status-machine.spec.ts`.

**Flows walked in the browser** (production build, demo clinic):

- **Book**: reception, 390 px, from the dashboard.
- **New patient inside the panel**: "Dorina Leka", added and booked.
- **Double booking**: 1440 px; another desk takes the time mid-booking.
- **Move and Undo**: 390 px, from the calendar list.
- **Check in and Undo**: 390 px.
- **Search → service → booking** with the service chosen: 1440 px.
- **Patient record**: Book and Move, 1440 px.
- **Empty calendar slot**: time, dentist and room known.
- **Recall → Book**: the patient leaves the list, 24 → 23.
- **Payment**: Pay 4,500 L → Paid → Receipt PDF, 390 px.
- **Console sign-in**: 390 and 1440 px.

**Checked by audit only** (overflow and axe per role), not walked step by step, because this pass did not change them:

- clinical charting;
- the odontogram;
- the cash drawer;
- inventory;
- WhatsApp;
- settings.

## 16. For review: the decisions in this pass

1. **The API offers times; the database still decides.**
   - Suggestions are advisory and computed per request from the window's bookings (± one day), with no cache.
   - The EXCLUDE constraints remain the authority, and a refusal is now answered with fresh times rather than an error.
   - Cost is days × dentists × quarter hours × that day's bookings: trivial for a clinic, and the query uses the existing `starts_at` indexes.
2. **A dentist's shifts win over opening hours.**
   - Someone with an evening shift is offered evenings even if the clinic "closes" at 17:00. Specific beats general.
   - Nobody is offered a time outside both, and a time can still be typed by hand under Details.
3. **"Usual dentist" means the one who saw the patient last** (completed visits), not the most frequent. It is simple to explain ("saw her last") and cheap.
4. **Undoing a check-in is a new transition** (`checked_in → scheduled`). It is recorded like every other.
5. **Search folds accents in SQL** (`translate` over the name columns). There is no extension and no migration.
   - It uses no index, but neither did the `%term%` match it sits beside.
   - A clinic with tens of thousands of patients would want `unaccent` and `pg_trgm`, which need a migration.
6. **`free-slots` read shifts as UTC.**
   - The older per-dentist endpoint turned "09:00" into 09:00 UTC, 11:00 in Tirana.
   - Nothing in the web app called it. It now uses the clinic's clock like everything else, and an integration test covers it.

## 17. Remaining limitations

1. **Recurring appointments do not exist** in DentalCare. They are in the brief's list of capabilities to keep. The brief also rules out new features in this pass, so none was added. Treatment plans sequence multi-visit work; a true "every 3 months" series needs a design decision and a migration.
2. **Calendar drag-to-move** is still not built. **Move** covers rescheduling. A drag could now ask `find-times` about the drop target, but it is not done.
3. **Payment method** starts on the clinic's first method (usually Cash). There is no memory per patient or per desk.
4. **Breaks** are modelled only by splitting a dentist's shift (09–13, 14–18). There is no separate lunch-break setting.
5. **No human-readable patient number.** The national ID is what "ID" searches. A clinic that files by its own card number would need a column, a migration and an import mapping.
6. **Settings** has no "Account" entry, because personal two-step lives in the sidebar user card. It has no inventory settings either, because there are none to show.
7. **Details uses the device's own date and time pickers**, so the format follows the device's language.
8. **Carried from earlier passes, unchanged:**
   - the VAT report's default period follows the server's clock;
   - Send history shows device-clock times;
   - Send history scrolls between 1081 and 1179 px;
   - the chart does not pass `appointmentId`.
9. **Production blockers, unchanged:**
   - runtime and Hyperdrive are unverified live;
   - fiscal certification is still needed against the tax authority's test service;
   - messaging providers have no credentials;
   - the public demo account's rules are undecided.
10. **Everything is uncommitted** on `preserve/pre-production-sept-9-18`, together with the earlier passes.
