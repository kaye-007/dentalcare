# DentalCare — UI/UX implementation

Date: 2026-09-26 · Follows [UI_UX_AUDIT.md](./UI_UX_AUDIT.md)

**Scope:** frontend only (`apps/tenant-web`, `apps/admin-web`).

**Unchanged:**

- no API, schema, auth, RLS, fiscalization or financial-calculation changes;
- every existing route still resolves at the same URL.

**How it was verified:**

- typecheck, lint, unit tests and builds were run;
- an isolated walkthrough ran in headless Chrome against a throwaway Postgres (:55432) and API (:3100) seeded with the demo clinic — never against the developer API on :3000;
- the redesigned screens were checked with axe-core, WCAG 2 A/AA, which reports 0 violations on the 23 routes checked.

This builds cleanly. That does not make it finished — see §8.

---

## 1. Components standardised

All shared components live in `apps/tenant-web/src/components/ui.tsx`. Their styles are in the new `src/experience.css`, which is loaded last and uses only the tokens.

| Component                                  | Replaces                                           | Notes                                                                                                |
| ------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Skeleton`, `LoadingRows`, `PageLoading`   | ~30 bare "Loading…" lines                          | They show the shape of what is coming. The shimmer is off under reduced motion.                      |
| `ErrorState`                               | red `formerror` blocks used as whole-screen errors | Plain words and a _Try again_ button.                                                                |
| `Segmented`                                | `<select>` for small option sets                   | A radiogroup with roving tabindex. The thumb slides (spring) to the choice.                          |
| `Disclosure`                               | always-visible optional fields                     | Opens itself when the browser rejects a required field inside it, so nothing invalid is ever hidden. |
| `MoreMenu`                                 | rows of secondary buttons in headers               | A full ARIA menu (arrows, Escape, focus return).                                                     |
| `ToastProvider` / `useToast`               | silent successes                                   | The same call shape as admin-web: `toast('Saved')`, `toast(msg, 'error')`.                           |
| `ConfirmProvider` / `useConfirm`           | 4 × `window.confirm`                               | Rooms, documents, WhatsApp disconnect, templates.                                                    |
| `humanError` + `toApiError` (`lib/api.ts`) | raw `err.message`                                  | See §5.                                                                                              |
| `MoneyInput`                               | —                                                  | Now forwards its `ref`, so a sheet can focus the amount on a validation error.                       |

**Visual design is unchanged.** A first version of this pass also restyled the product: it removed the colour bloom and the glass effect, shrank the radii and flattened the buttons. That restyling was **reverted at the owner's request** — the existing "Ink & Ember" look (warm bloom, glass sidebar and top bar, ink pill buttons, ember accents) stays.

What remains in `styles.css`:

- the hooks the new components use (`--input-h`, motion tokens, `.btn--quiet`, and `.formwarn` drawn like the existing error box in warning colours);
- two small contrast fixes: `--muted-2` `#7b7b84` → `#6c6c74`, and full-opacity secondary lines on appointment cards.

---

## 2. Navigation

`lib/navigation.ts` is the single map. The sidebar, the section tabs and the breadcrumb all read from it. The 16 sidebar entries become **seven destinations**:

| Section   | Pages (tabs under the header)                                |
| --------- | ------------------------------------------------------------ |
| Dashboard | —                                                            |
| Calendar  | Calendar · Messages                                          |
| Patients  | All patients · Import                                        |
| Clinical  | **Today** (new) · Services & prices · Inventory              |
| Payments  | Invoices · Payments · Cash drawer · Expenses · Fiscalization |
| Reports   | Overview · Reports · Activity                                |
| Settings  | Clinic · Staff · Rooms & hours                               |

How it behaves:

- A section tab row (`SectionNav`) appears only when the user can open more than one page in that section.
- Visibility uses the same permissions and feature flags as before. Several pages that had no gate now carry the permission their API already enforces:
  - `patients:read`
  - `appointments:read`
  - `treatments:read`
  - `clinical:read`

  This means an accountant is no longer shown links that return 403.

- The breadcrumb names the section. On a detail route it names the list and links back to it.

Renamed in the product's own words:

- Reservations → **Calendar**
- Treatments → **Services & prices**
- Fiscal queue → **Fiscalization**
- Financials → **Overview**

Removed from the top bar: the Messages and Reminder-log icons, which duplicated the Calendar section. What remains: search · drawer chip · _New_.

---

## 3. Pages redesigned and workflows simplified

**Dashboard — one lens per role** (`DashboardPage.tsx`)

- **Reception and assistants:** today's schedule, with the next patient marked, plus who still owes. The primary action is _New appointment_.
- **Dentists and hygienists:** their own column today (everyone's, if they have none), with Waiting / In the chair / Done counts. The primary action is _Today's patients_.
- **Owner:** today, plus one "This month" money card, plus who owes.
- **Accountant:** money only, with no schedule and no patients.
- Removed from all views:
  - the Quick actions card, which duplicated the _New_ menu;
  - "Recent patients", which was sorted by registration date and was not useful day to day.
- The two stock alert bars merged into one line.
- The greeting uses the first name, skipping "Dr.".
- Each role now requests only the data it can see. For example, a dentist no longer fetches every invoice.

**Clinical › Today** (new, `ClinicalPage.tsx`)

- A hero card for the next patient, or the one in the chair. It has one forward step through the existing state machine (Check in → Start treatment → Complete), then _Chart_, _Treatment plan_, _Note_ and _Next visit_.
- The rest of the day is in time order below; what is done recedes.
- A _My patients / Everyone_ segmented control.

**Patient record** (`PatientProfilePage.tsx`)

- **Header:** who they are, with the allergy flag always visible; four primary actions (**Appointment · Clinical note · Treatment · Payment**); Edit as a quiet button; Archive moved into _More_.
- **Facts row:** Phone · Next appointment · Last visit · **Balance** ("Owes €258", or "Settled").
- **Payment** goes straight to the open invoice with the sheet already open, when there is exactly one; otherwise it opens the Billing tab.
- **Overview:** one **History** timeline. It shows _Coming up_ first, then visits and notes merged newest-first, with "Show N more" after 8. The note composer sits at the top of it, and its _Add note_ button appears only once something is typed.
- The side rail shows Medical history, then _Contact & details_ collapsed with a summary hint, then record access for admins.
- Tab content re-fades on change.
- **Bug fixed:** the date-only regex in `fmtDate` was `/^d{4}-d{2}-d{2}$/`, with its backslashes lost. It never matched, so birth dates were formatted as instants in the clinic's time zone.

**Booking panel** (`AppointmentModal.tsx`)

- The order is now **Patient → What for → When and with whom → Room**, the order a call to the desk goes.
- It warns when a practitioner is double-booked (new), as well as when a room is taken. Both are calm `formwarn` notes, not red errors, and both still allow an intended overlap.
- The contact card is reduced to the phone number plus any allergy.
- The duration option shows the end time.
- The button says what happens: "Book for 14:30".

**Payments** (`InvoiceDetailPage.tsx`)

- **Invoice header:** status, then _More_ (PDF, fiscal receipt, issue as fiscal, cancel invoice…), then **Take payment**. Cancelling now asks first; before, it cancelled on a single click.
- **Payment sheet:**
  - A large amount field (it grows with the digits).
  - A method **segmented control**, falling back to a select above four methods.
  - The document type is taken from the clinic default and shown as one line with _Change_. It is the full two-option chooser only when the clinic is set to "ask".
  - The note sits behind _Add a note_.
  - A full-width **Take €30** button.
  - A part-payment hint shows what will remain, with a _Pay all_ shortcut.
- **Success state:** the sheet turns into a receipt — a check that pops once, the amount, method and document, then "Paid in full" or "€X still to pay", plus _Print receipt_ or _Receipt PDF_.
  - If fiscal registration failed, it says plainly that the payment is recorded and queued for retry.
- The idempotency key, the drawer-closed flow ("start the drawer here, then pay") and the fiscal and internal choice are unchanged.
- The `/payments` list gained loading, error-with-retry and empty states. It used to hang on "Loading…" forever if the load failed.

**Cash drawer** (`CashDrawerPage.tsx`, `EndDayModal.tsx`)

- **Closed:** one large _Opening cash_ figure, then **Start drawer with €X**.
- **Open:** one large **Expected cash** figure, who started it and when, and the number of cash payments, then **Close drawer** and _Take cash out_.
  - The blind count is respected: the expected figure is "revealed after you count", as before.
- **At close:** Expected and Counted, then a rule, then a **large Difference** coloured by band.
  - A sentence explains it: "The drawer is €500 short of what it should hold", plus what the band requires (a note, or manager approval).
  - The done state reuses the payment receipt pattern.
- The page waits for feature flags before rendering. It used to request manager sessions for a drawer that was switched off, which returned 403.

**Forms**

- **Patient form:**
  - Name, phone, date of birth and email come first, then the WhatsApp consent (asked at intake).
  - Everything else sits under **Additional information**, which opens by itself on edit when any of those fields are already filled.
  - _Status_ is shown on edit only.
  - Input is kept on error, and the message says so.
- **Settings:** the second row of tabs is replaced by a **section list beside the content** (sticky). On narrow screens it becomes a horizontal scroller.

**Tables and lists**

- The patient list shows its _Status_ column only in the "All" filter, instead of "Active" on every row.
- A duplicate _Import_ button was removed; it lives in the section tabs.

**Superadmin console** (`admin-web`)

- Styling is unchanged; the stylesheets were restored to their committed versions.
- **Overview:** **Needs attention** leads, full width, when there is anything. Then the KPIs, then revenue next to recent activity. _Revenue by plan_ and _New clinics_ fold under **Plans and growth**.

---

## 4. Motion added

The rules: 120–260 ms, decelerating; a spring only where something settles into place. Everything is off under `prefers-reduced-motion`, through the existing global rule and explicit overrides for the new pieces.

| Where                           | What it says                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Route change                    | The page fades in (opacity only — a transform here would re-anchor `position: fixed` dialogs mid-fade; found and fixed during the walkthrough). |
| Tabs (patient record, settings) | The content fades on change.                                                                                                                    |
| Section tabs                    | The underline grows under the chosen page.                                                                                                      |
| Segmented controls              | The thumb slides to the new option.                                                                                                             |
| Disclosure                      | The chevron rotates; the body rises in.                                                                                                         |
| More menu                       | Scales out from its button.                                                                                                                     |
| Odontogram                      | The tooth dips on press; the selection ring settles onto the chosen tooth; that tooth's record slides in (keyed per tooth).                     |
| Payment and drawer success      | The check pops once and the amount rises in.                                                                                                    |
| Drawer figures                  | The expected amount rises in when the drawer opens.                                                                                             |
| Errors                          | The inline error rises in, so a new message is noticed.                                                                                         |
| Buttons                         | Press settles by 1.5%. Nothing else animates on hover.                                                                                          |

---

## 5. Error language

- `toApiError` rewrites any 5xx response, and any message that looks technical (SQL, driver, proxy, runtime, Cloudflare or Hyperdrive words), to _"Something went wrong on our side. Please try again in a moment."_
- It maps Nest's bare 403 and 404 to sentences a person can act on.
- It rewrites 429 and 413 to plain sentences.
- A network failure is now an `ApiError` with the code `network`: _"DentalCare could not be reached. Check the internet connection and try again."_
- `humanError(err, fallback)` is used at the call sites:
  - it passes authored messages through, from `ApiError` and from plain `Error`s thrown on purpose by client code;
  - it replaces runtime errors (`TypeError` and similar) with the caller's own fallback.
- About 45 call sites were moved to it.

---

## 6. Accessibility

- axe-core, WCAG 2 A/AA: **0 violations** on the 23 routes checked as the admin user. The fixes found along the way:
  - inactive tab and segment text (4.3:1 → 6:1);
  - the agenda end-time and `--muted-2` (now at least 4.5:1);
  - faded appointment-card sub-lines (the opacity was removed);
  - two unlabelled report date inputs;
  - the unlabelled brand-colour hex input.
- New controls follow the ARIA patterns: radiogroup with roving tabindex, disclosure with `aria-expanded`/`aria-controls`, menu with arrow keys and Escape, a polite live region for toasts, and `aria-current` on the section tabs and sidebar.
- Void-payment icon buttons now have accessible names that include the amount.
- Touch targets stay at 44 px below 760 px, including the new section tabs and the settings list.

## 7. Responsive

- The walkthrough ran at 1440, 1024 and 390 px wide.
- **Phone:** the patient header pins Edit and More top-right, and the four actions form a 2×2 grid.
- **Phone:** the dashboard stacks with the primary action full width.
- Narrow pages (such as the patient form) now line up with the section tabs instead of floating in the centre.

---

## 8. Remaining UX debt

1. **Calendar grid:**
   - The week view is restyled but not redesigned. It has no drag-to-move and no inline time editing, and moving an appointment still goes through the panel.
   - Smooth appointment movement needs drag-and-drop plus an optimistic update.
2. **Inventory, Reports, Financials and Staff** only received the token and state pass. Inventory's four tables and Reports' charts still read dense.
3. **Messages (WhatsApp)** is untouched beyond tokens and states. It still carries its own tab row inside the Calendar section.
4. **Invoice list and new-invoice modal:** the "new invoice then take payment" path is still two screens. A combined "bill and take payment" sheet would remove a step.
5. **Patient record:** Dental chart and Perio are still stacked on one tab, and the Treatment plan card is long. Progressive disclosure inside those cards was not attempted.
6. **Inline styles:** about 180 `style={{…}}` remain, mostly in older pages.
7. **Pre-existing formatting:** `npm run format:check` still reports the same **32 files** it reported before this pass. They are the working tree's other pending changes, including 16 API files, and were deliberately left alone. Every file this pass touched that was not already on that list is Prettier-clean.
8. **Bundle size:** the tenant bundle is still one chunk of more than 500 kB. Route-level code splitting would help first load.
9. **Admin console:** only the Overview was restructured. The tenant detail page (1,373 lines) is the next candidate.
10. **The dentist's "my patients"** depends on `appointments.staff_id` matching the signed-in user's id. That is true for the seeded clinic; it should be checked on real data.

## 9. Backend changes that would help next

- **Patient summary endpoint:** one call returning the balance, the open invoice ids, and the next and last visit. Today the header makes three requests, and the balance comes from the ledger endpoint, which **records a "viewed billing" access entry** (deduplicated per 5 minutes) whenever a user who can read invoices opens a record.
- **Invoices filtered by patient id:** `GET /invoices?patientId=`. The record currently searches by name and filters on the client.
- **Appointment move endpoint** that accepts start, practitioner and room in one call and returns conflicts, so the calendar can support drag-to-move with server-confirmed conflict checks.
- **Practitioner conflict check on the server:** the new double-booking warning is client-side and advisory only.
- **Checkout in one call:** create the invoice and take the payment together, for the walk-in flow.
- **Structured error codes** on more 4xx responses, so the UI can explain them without relying on the text.

---

## 10. Reception pass (phone first)

Walked through as the seeded receptionist at 390 px wide, then fixed what got in the way.

**Dashboard (desk)**

- **Coming up** fills the space under Today:
  - the next 7 days as tappable columns (count and a fill bar), each opening that day in the calendar through `?date=`;
  - tomorrow's patients with a **Call** button, for the daily confirmation calls.
- Today's rows get the desk's two most common taps:
  - **Call** (a `tel:` link);
  - **Check in** on scheduled visits, or **Bill** on visits in progress or completed.
- **Bill** is hidden once the patient has an invoice issued today, so nobody bills twice from the list.
- The date and greeting now follow the clinic's clock, not the browser's.

**Billing in one flow**

- **Bill** opens a new invoice with the patient already filled in (`/invoices?new=1&patient=…`).
- Creating it goes straight to the invoice with the payment sheet open (`?pay=1`).

**Booking panel**

- The order within the step is now practitioner, then date, then time.
- **Free times** appear as tap targets:
  - they come from the clinic's opening hours minus the practitioner's other bookings;
  - they skip past times;
  - there are 12 at first, and the rest behind "N more".
- A suggested start (the New button) moves to the first free time, and off a closed day to the next open one.
- A closed day says so, with a _Go to next open day_ button.
- If nobody on the staff is marked _Sees patients_, the dentists, hygienists and admins are offered instead of an empty list. The seeded clinic had this problem.

**Phones**

- A glass **bottom tab bar** (Home · Calendar · Patients · Payments · More) replaces the hamburger. _More_ opens the full menu.
- The invoice and payment tables drop their secondary columns below 760 px.

**Calendar list view**

- A **List** view (next to Day / Week / Month) is the default on phones. It shows one day in time order, with the next patient marked.
- Each row has the desk's actions: **Call**, **Check in**, or **Bill**. **Bill** hides once the patient has an invoice dated that day. Tapping a row opens the visit.
- A chip row filters by practitioner (Everyone · Dr … · Dr …) instead of one column each.
- A closed or empty day shows a clear empty state with _Book an appointment_.
- The Coming up strip on the dashboard opens its day in this view on phones.

**New patient straight from booking**

- When the search finds nobody, **New patient "…"** asks for first name, last name and phone, then uses that patient for the booking.
- The name the user typed pre-fills first and last name; a typed number pre-fills the phone.

**Other fixes**

- The calendar's _New appointment_ button now also starts on the first free time.
- The patient list on a phone shows name plus phone and city; the columns that scrolled sideways are hidden.
- The invoice page on a phone: Total / Paid / Balance sit in one row, and the line items drop Unit price and TVSH.
- The phone menu returns focus to the _More_ tab that opened it (it used to target the hidden menu button).
- axe WCAG A/AA at 390 px wide, as reception: 0 violations on 6 routes.

**Still open**

- The appointment panel is still a long form on a phone. Splitting it into steps (one screen each) would shorten it further.
- The invoice line-items footer (TVSH summary) is slightly misaligned on phones while columns are hidden.
