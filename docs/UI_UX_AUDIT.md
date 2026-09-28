# DentalCare — UI/UX audit

Date: 2026-09-26 · Scope: `apps/tenant-web` (clinic app) and `apps/admin-web` (NODE X console)
Method: read every route, the layout shell, the shared primitives (`components/ui.tsx`), the
6k-line `styles.css` and the five module stylesheets, and walked the main workflows in code. No code
was changed during the audit.

The base is better than most admin UIs. It already has one page-header pattern, one
empty-state pattern, one pill system, accessible dialogs (focus trap, Escape, return focus), an
ARIA tabs pattern on the patient record and a keyboard-driven patient search. Most of the problems
below are **accumulation**: good pieces added one module at a time, with no single hierarchy
tying them together.

---

## 1. Findings

### 1.1 Navigation — too many destinations, technical names

- The sidebar has **16 destinations in 4 groups**: Dashboard · Reservations, Messages, Patients,
  Treatments, Staff, Rooms, Inventory · Invoices, Payments, Cash drawer, Fiscal queue, Expenses ·
  Financials, Reports, Activity, plus Settings in the footer.
- Several are one job split across pages. For example, _Invoices / Payments / Cash drawer /
  Fiscal queue / Expenses_ are all "money in and out", and _Financials / Reports_ are both "how
  the clinic is doing".
- Some names are implementation words: "Reservations" for the calendar, "Treatments" for the
  price list, "Fiscal queue".
- There is no "Clinical" destination. A dentist's day (today's patients → chart → note) has no
  home, so it starts from a receptionist-shaped dashboard.
- The topbar repeats destinations the sidebar already has: Messages icon, Reminder-log bell,
  drawer chip, a _New_ menu, search, and a mobile search link. That is six controls competing on
  every page.

### 1.2 Visual language — "liquid glass" works against _calm_

- `body` paints three coloured radial-gradient "blooms". The sidebar, topbar and ghost buttons
  are translucent with a 20px backdrop blur.
- Radii are deliberately very large (12/20/26px) — the stylesheet calls this "the single
  cheapest signal of designed". Combined with two-layer card shadows, every card floats and
  everything looks equally important.
- **Ghost buttons are glass** (blur + white rim + shadow). A secondary action therefore carries
  almost as much weight as the primary one.
- The primary button has a coloured drop shadow and an inset highlight.
- Result: _decorative elements without purpose_, _excessive shadows_, _excessive rounded
  cards_ — three of the brief's "avoid" items.

### 1.3 Hierarchy and "one primary action"

- Dashboard: _New appointment_ (primary) plus a Quick-actions card (3 more) plus the topbar _New_
  menu — the same verbs in three places.
- Patient profile header: _Book appointment_, _Edit_, _Archive_ sit side by side. Archive is rare
  and consequential but has the same weight as Edit. The four things a clinician does most (note,
  treatment, payment, appointment) are spread across tabs.
- Invoice detail: up to **7 controls** in the header — status pill, document pill, PDF, Fiscal
  receipt, Fiscalize, Cancel invoice, Record payment.

### 1.4 Dashboards — one layout for every role

- Owner, receptionist, dentist and accountant all get the same page: schedule, quick actions,
  money (owner only), awaiting payment, recent patients.
- A dentist sees _Awaiting payment_ and _Recent patients_ (sorted by _registration_ date, not by
  visit). Neither helps clinical work.
- An accountant (no patient access) gets a schedule and patient lists.
- Up to two stock alert bars sit above everything, even for staff who cannot act on them.

### 1.5 Patient record

- The header is good (allergy flag in the header, next/last visit). But "What do they owe?" is
  **not answered** until you open the Billing tab.
- _Overview_ leads with a full demographic dump (address, postal code, WhatsApp consent source…)
  in the widest column. The clinically useful parts — upcoming visits and notes — are in the
  narrow rail.
- **Bug:** `fmtDate` uses the regex `/^d{4}-d{2}-d{2}$/`, which is missing its backslashes. It
  never matches, so date-only values such as a birth date are formatted as instants in the
  clinic zone.
- Loading shows the plain text "Loading patient…" in an otherwise empty page.

### 1.6 Calendar and booking

- The booking panel is well built: side panel, the calendar stays visible, and room conflicts are
  shown per room.
- But the order is _Service → Patient → When_. At a front desk, the call starts with the patient.
- **Practitioner double-booking is not flagged at all** — only rooms are checked.
- The contact card repeats phone, email and full address. Only the phone and a severe allergy
  matter at booking time.
- A room conflict and a closed day both use `.formerror` (the big red block) for what are
  warnings.

### 1.7 Payments — a modal full of decisions

- The _Record payment_ modal asks for: amount, a method `<select>`, a two-card
  fiscal/internal document chooser with paragraph-length explanations, and a note — every time.
- The amount is a small field beside the method. Method is a dropdown even though clinics have
  2–4 methods, so it should be a segmented control.
- After saving, the modal just closes. There is no confirmation of amount or method, no receipt
  action and no remaining balance.
- `/payments` has no error handling: a failed load leaves "Loading…" forever.

### 1.8 Cash drawer

- The logic is careful and good: blind count, variance bands, manager PIN, idempotency. Do not
  change it.
- The UI is small: "In the drawer" is a stat in a generic `.stats` strip, and the _Start the day_
  box has an icon, a title and a paragraph before the amount.
- At close, Expected / Counted / Difference use the same size, so the difference — the thing
  that matters — does not dominate. A difference is labelled "Needs a note" instead of
  explaining in words what happened.

### 1.9 Forms

- _New patient_ shows **19 fields plus two fieldsets** at once, although the form says only two
  names are required.
- Emergency contact, WhatsApp consent, address and national ID are all visible up front.
- Errors are a red box above the buttons (`.formerror`) — the "giant red error block" pattern.
- There are `window.confirm` dialogs in Rooms, Documents and WhatsApp settings: native, unstyled
  and inconsistent.

### 1.10 Tables

- Tables are mostly reasonable (5–6 columns). Headers are 12px UPPERCASE with a letter-spaced
  tinted band. That is heavier than the data it labels.
- Inventory and Reports use `table--compact` spreadsheets. They are acceptable there, because
  comparison is the job.

### 1.11 Empty, loading and error states

- **Loading:** about 30 places render the plain text "Loading…". Some use `<p className="pad
muted">`, some `<div>`, some no padding at all. There are no skeletons.
- **Errors:** screens show `err.message` verbatim. For 4xx that is the API's authored sentence,
  which is fine. For 5xx or network failures it is `Internal Server Error`, `Failed to fetch` or
  a Cloudflare status text. There is no retry anywhere.
- **Empty:** the `EmptyState` component is good, but its use is inconsistent: "No payments
  recorded yet." and "No unpaid invoices. Nice." are bare lines, while others use the full
  pattern.
- **Success:** the clinic app has **no toast system** (admin-web has one). Successful saves are
  silent unless a page navigates.

### 1.12 Motion

- Dialogs fade and rise, and the side panel slides — good and short.
- Nothing else moves. There is no transition between tabs, on odontogram selection, on the
  payment result or on section changes.
- `prefers-reduced-motion` is handled for some pieces but not globally.

### 1.13 Accessibility

- Good: skip link, a global `:focus-visible`, labelled icon buttons, dialog semantics, tablist
  semantics, 44px touch targets below 760px.
- Gaps:
  - Icon-only buttons with `title` but no `aria-label` (void payment).
  - Clickable table rows whose keyboard target is a nested link — acceptable.
  - 181 inline `style={{…}}` attributes, which bypass the tokens.
  - Muted text `#6a6a72` on the warm canvas is fine; `#8a92a3` placeholders are borderline.

### 1.14 Superadmin console (admin-web)

- It already has toasts, a confirm provider and a command palette.
- The overview has a KPI strip plus six cards. It shares the same glass tokens, so it needs the
  same calming pass. Keep the token files in step, as its own header comment requires.

---

## 2. Proposed improvements

| Area       | Change                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tokens     | Remove the gradient bloom and the glass on ghost buttons. Radii 8/12/16. One soft card shadow (or a hairline). Motion tokens (`--ease-out`, `--dur-1/2/3`). Global reduced-motion.                                                                                             |
| Navigation | 7 destinations: **Dashboard · Calendar · Patients · Clinical · Payments · Reports · Settings**. Each section shows its sub-pages as a contextual tab strip under the header. All existing routes stay. Topbar reduced to search · drawer chip · New.                           |
| Dashboards | Role-shaped: **front desk** gets today's schedule plus who is waiting plus open balances. **Clinician** gets my patients today, next patient first. **Owner** gets today plus one money card. **Accountant** gets money only.                                                  |
| Patient    | The header answers who / next / last / **owes**, with four primary actions (Appointment · Note · Treatment · Payment). Archive moves to a "More" menu. Overview leads with upcoming visits and notes; demographics collapse.                                                   |
| Calendar   | Booking order Patient → Service → When (practitioner, time) → Room. Warn inline on practitioner double-booking as well as room conflicts. Warnings become calm amber notes, not red blocks.                                                                                    |
| Clinical   | A new **Clinical › Today** page (frontend only, from the appointments API): my patients today, with direct links into chart, plans and notes. The treatment catalogue and inventory sit beside it as tabs.                                                                     |
| Payments   | The payment sheet leads with the amount (large). Method is a segmented control. The document choice is pre-set from settings and collapsed behind "Change". The note goes behind "Add a note". A **success state** shows amount, method, receipt action and remaining balance. |
| Drawer     | A large "physical" figure for the cash in the drawer. The closing summary makes the difference the dominant number and explains it in words ("The drawer has 500 L less than expected").                                                                                       |
| Forms      | Patient form: name, phone, email, date of birth up front. Everything else sits under "Additional information", which opens automatically when editing a record that already has any of those values.                                                                           |
| States     | Shared `<Skeleton>`, `<LoadingRows>` and `<ErrorState onRetry>`. A human error mapper in `api.ts` for 5xx/network. `ToastProvider` in tenant-web for silent successes.                                                                                                         |
| Motion     | Tab/section content fade-rise (120–180ms), payment success check, selection transitions on odontogram teeth, drawer figures. Everything off under reduced motion.                                                                                                              |

---

## 3. Pages affected

- **All pages:** tokens, shell, navigation, loading and error states.
- **Redesigned:** Dashboard, Patient profile, Patient form, Invoice detail (payment sheet),
  Payments list, Cash drawer (+ end-of-day result), Appointment panel, new Clinical › Today.
- **Restyled only:** Invoices, Expenses, Fiscal queue, Treatments, Staff, Rooms, Inventory,
  Reports, Financials, Activity, Settings, Messages, and the admin-web shell and pages.

## 4. Components to standardise (one each)

- `PageHeader` — already exists; use it on the invoice and patient-form pages that hand-roll it.
- `SectionNav` (new) — the contextual tab strip for a section's sub-pages.
- `EmptyState` — already exists; replace the bare "No … yet" lines.
- `Skeleton` / `LoadingRows` (new) — replace every "Loading…" line.
- `ErrorState` (new) — human message plus _Try again_.
- `Toast` (new in tenant-web, the same API shape as admin-web's).
- `Segmented` (new) — method pickers and small option sets. The `.tabs` look already exists.
- `Disclosure` (new) — "Additional information", "Add a note", "Change document".
- `MoreMenu` (new) — secondary and destructive actions out of headers.
- `Modal` / `SidePanel` — already exist; add a `size` and a success-state slot, not a new dialog.

## 5. Do NOT duplicate

- Dialog focus handling (`useDialog`) — every overlay goes through `Modal` or `SidePanel`.
- Status colours — only through `StatusPill` and `--ok/info/warn/danger/neutral`.
- Money formatting — `formatMoney` from `lib/format` (clinic currency) or `@dentalcare/shared`
  (explicit currency). Never format by hand.
- Clinic-time formatting — `inClinicZone` / `clinic-time.ts`.
- Permissions — `useAuth().can`. Nav visibility reads the same permissions as today.
- Money-moving calls — the existing idempotency keys stay exactly where they are.

## 6. Out of scope (explicitly)

- No changes to the API, schema, auth, RLS, fiscalization or financial calculations.
- Drawer blind-count rules, variance bands and approval flow are unchanged. Only their
  presentation changes.
