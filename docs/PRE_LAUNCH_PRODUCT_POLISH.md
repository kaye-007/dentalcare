# DentalCare — pre-launch product polish

Date: 2026-09-27 · Follows [UI_UX_IMPLEMENTATION.md](./UI_UX_IMPLEMENTATION.md) · Branch `preserve/pre-production-sept-9-18`, uncommitted

**What this pass did:** it tightened the existing product for launch. It rebuilt nothing and added no dependencies.

**What stayed as it was:**

- the architecture, routes, permissions and schema (no migrations);
- the visual language — "Ink & Ember", glass and bloom. All new styling uses the existing tokens.

**Where the new styles live:** one new stylesheet, `apps/tenant-web/src/polish.css`. It is loaded last, is sectioned by concern, and changes layout, density and phone structure only.

**How it was verified:**

- Everything ran against an isolated stack: a throwaway Postgres on :55432, the API on :3100, and Vite on :5199 and :5198, seeded with the new demo.
- It never touched the developer's own API on :3000 or database on :5432.
- Screens were checked in headless Chrome at 320, 375, 390, 414, 768, 1024, 1280 and 1440 px, and with axe-core. See §14 and §15.

---

## 1. UI changes (summary)

| Area           | Change                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------- |
| Phone shell    | Brand header, search in place, role-aware tab bar, section tabs that keep the active tab in view    |
| Today lists    | One compact row per visit on phones; "Scheduled" pills dropped where the time already says it       |
| Patient record | Charges and payments on the History timeline, beside visits and notes                               |
| Search         | Phone numbers match however they are typed; name-prefix ranking; invoice numbers; Ctrl/⌘ K          |
| Payments       | Lek shown as "3,000 L" everywhere; the lek sign follows the amount in the payment sheet             |
| Cash drawer    | Clinic-time timestamps; "Balanced" instead of "ALL balanced"                                        |
| Inventory      | Status column (In stock / Low stock / Out of stock), Stock in / Stock out on every row, phone cards |
| Services       | Renamed to "Services & prices" throughout; phone list; quieter table                                |
| Settings       | Grouped sections (Clinic · Payments · Communication · System); the phone gets a settings list       |
| Clinical       | Secondary chart switches behind "View options" on phones                                            |
| Performance    | Route-level code splitting: first download from ~499 kB to 327 kB                                   |

## 2. Mobile changes

**Header (≤760 px).** The DentalCare mark and the clinic name now sit where the breadcrumb is on desktop, so the logo is always visible. The bar is 52 px high plus the safe-area inset. It stays fixed while the page scrolls under it.

**Search.** The search button used to jump to the patient list. It now opens search over the header:

- a full-width box, with 16 px text so iOS does not zoom on focus;
- results as 52 px rows;
- a **Cancel** button.

Picking a result, pressing Escape or changing route closes it.

**Tab bar.** It never scrolls, and holds five fixed destinations: **Home · Calendar · Patients · (Clinical or Payments) · More**.

- The fourth tab follows the role. Dentists, hygienists and assistants get **Clinical**. Reception, the owner and the accountant get **Payments**.
- Everything else sits under **More**, which is the full menu.
- The active tab gets an ember marker that slides in.
- Labels never wrap, and the bar respects `safe-area-inset-bottom`.

**Section tabs** (e.g. Invoices · Payments · Cash drawer · Expenses · Fiscalization):

- the row scrolls inside itself, with a fade at the edge that shows it continues;
- the active tab is scrolled into view on arrival, instead of sitting off-screen.

**Anchoring.**

- `html`, `body` and `.content` clip horizontal overflow, so the page itself can never slide sideways.
- Anything wider than the screen (a table, the week grid, a chart) scrolls inside its own card.
- The last page-level overflow was the Financials range switcher. Page-header actions now wrap, and a switcher scrolls inside itself.

**Today rows (dashboard and calendar list).** Before, each visit was about 112 px tall because its buttons wrapped onto a second line. Now each visit is one row of about 64 px:

- time, then patient and reason, then one action (Check in or Bill);
- the call button hides below 360 px.

**Settings on phones** open on a grouped list, like a phone's own settings:

- each row has a name and a one-line hint;
- one tap opens a section, and "‹ Settings" goes back.

**Inventory and Services on phones** are compact card or list rows instead of tables that scrolled sideways.

## 3. Desktop changes

- The inventory list lost its amber tint on every low row. The Status column says it now, and the tint is kept for expired stock only.
- In Services & prices:
  - prices are right-aligned, bold and never wrap;
  - "Status: Active" is shown only in the _All_ filter;
  - TVSH reads "Exempt" in plain text, with a pill only for the exception (cosmetic, taxed);
  - "Visits" reads One / Several.
- Settings uses a grouped side list with eyebrow labels. Staff & doctors, Rooms, Services & prices and WhatsApp & reminders are listed as links, so every setting is found from one place. The redundant tab row above Settings was removed.
- The sidebar, content width and spacing scale were already compact after the previous pass and were left alone.

## 4. Patient UX

- **History timeline.** The ledger the record already loads for the balance now also feeds the timeline, so no extra request is made. The timeline reads newest first:
  - "Invoice INV-0691 · 50,000 L — Balance 50,000 L"
  - "Payment · 30,000 L — Cash · Balance 20,000 L"
  - the visits and notes around them.

  Money entries link to their invoice. A charge is an ember ring; a payment is a filled ink dot. Staff who may not see money get no money entries.

- The header, with its four primary actions (Appointment · Clinical note · Treatment · Payment), its secondary actions under _More_, and its balance fact, is unchanged from the previous pass.

**Patient search** (top bar, and the patient list's own search box):

- It searches name, surname, phone, email and national ID.
- **Phone numbers are compared digit by digit, without the trunk 0 or the country code.** So "069 123 4567", "0691234567" and "+355691234567" all find "+355 69 123 4567".
- Names that _start with_ the typed text come first, then the rest alphabetically. Before, results came newest-registered first.
- An integration test covers all of this: `apps/api/test/integration/patient-search.itest.ts`.

## 5. Clinical UX

- In Clinical › Today and the clinician's dashboard, a status pill appears only when the state is not "Scheduled": checked in, in the chair, done, no-show or cancelled.
- The dental chart on a phone shows the Arch/Surfaces switch. Adult/Pediatric and FDI/Universal, which are set once per patient, sit behind **View options**.
- Tooth selection was re-checked at 390 px. It already works: the tooth is highlighted, its record slides in, and it saves in place.

## 6. Payment UX

- **Money format.** Lek is written the Albanian way, **"3,000 L"**, instead of Intl's "ALL 3,000". This is done in the shared formatter (`packages/shared/src/money.ts`), so the API's audit lines, the PDFs and both SPAs agree.
  - `currencySymbol('ALL')` is "L".
  - `parseMoney` accepts "3,000 L".
  - A no-break space keeps the number and its sign together.
- **Payment sheet** (from the previous pass: amount first, a method segmented control, one full-width button, a receipt state on success).
  - The lek sign now follows the amount ("20000 L").
  - "Issues a internal receipt" now reads "Issues an internal receipt".
- **Walkthrough.** A 20,000 L cash payment on Gentian Meta's invoice:
  - turns it _Paid in full_;
  - shows the receipt state (✓ 20,000 L · Cash · internal receipt · Receipt PDF / Done);
  - raises the open drawer's expected cash from 20,000 L to 40,000 L.

## 7. Cash drawer

- **Time zone.** "Started by … at 00:50" was the browser's time zone, not the clinic's. It now reads 06:50, Tirana time. The Activity page had the same bug, in its day grouping ("Today", "Yesterday") and its times, and is fixed too.
- **Balanced label.** A drawer that balances in the clinic's own currency reads "Balanced". The currency code is added only where a second currency could be meant.
- **Demo data.**
  - One open drawer today: Ana Kola, 20,000 L float.
  - 70 closed past days. Each has its float, every cash payment of that day as a hash-chained event, a count and a review.
  - One day is **short 500 L, with its explanation recorded.** The past-days list shows it as "Short 500 L".
  - All 71 chains verify with the app's own `verifyChain`, read through `/api/drawer/sessions/:id`.

## 8. Inventory

- The primary actions are **Add item** (page), and **Stock in** and **Stock out** (every row). They open the existing movement form with that kind already chosen.
- Lots, History, **Count stock** (an adjustment), Edit and Archive/Restore moved into a per-row _More_ menu. Before, each row had up to five icon buttons.
- The columns are **Item · Category · Stock · Minimum · Status**. Status is In stock, Low stock or Out of stock, in words plus colour. The "Reorder at" column is now "Minimum".
- Stock out is disabled at zero.
- **Demo stock.** 54 generic items, with no brands and no suppliers, in eight categories:
  - Consumables, Anesthesia, Disposables, Endodontics, Prosthodontics, Sterilization, Orthodontics, Implantology;
  - 13 at or below minimum, 2 of them out of stock;
  - four lot-tracked items (anesthetics and implant fixtures), one lot expiring inside the 60-day warning;
  - every item has a delivery and a usage movement, so its history adds up.

## 9. Service / treatment catalog (DEMO price list)

30 services, with the Albanian name first and English in brackets. This is how a Tirana clinic writes its own list, and it reads fine next to an English UI.

**The prices are an illustrative DEMO list, not any real clinic's fees.** All of them are VAT-exempt medical services, which keeps every demo invoice's TVSH at zero. They are listed below in lek:

| Service                                          |      L |     | Service                                     |      L |
| ------------------------------------------------ | -----: | --- | ------------------------------------------- | -----: |
| Konsultë (Consultation)                          |  1,500 |     | Implant dentar (Dental implant placement)   | 60,000 |
| Kontroll periodik (Check-up & examination)       |  2,000 |     | Abatment (Implant abutment)                 | 15,000 |
| Radiografi periapikale (Dental X-ray)            |  1,000 |     | Kurorë metal-qeramike (Metal-ceramic crown) | 12,000 |
| Radiografi panoramike OPG                        |  3,000 |     | Kurorë zirkoni (Zirconia crown)             | 25,000 |
| Pastrim profesional (Professional cleaning)      |  4,000 |     | Kurorë E-max (E-max crown)                  | 30,000 |
| Heqje guri (Scaling)                             |  3,000 |     | Kurorë e përkohshme (Temporary crown)       |  3,000 |
| Polirim (Polishing)                              |  1,500 |     | Cementim kurore (Crown cementation)         |  2,000 |
| Zbardhim dhëmbësh (Whitening)                    | 20,000 |     | Kunj dhe kore (Post and core)               |  6,000 |
| Mbushje kompoziti (Composite filling)            |  4,000 |     | Fasetë porcelani (Porcelain veneer)         | 30,000 |
| Mbushje e përkohshme (Temporary filling)         |  1,500 |     | Fasetë kompoziti (Composite veneer)         | 10,000 |
| Trajtim kanali, 1 kanal (Root canal, single)     |  8,000 |     | Urë dentare, për element (Bridge, per unit) | 12,000 |
| Trajtim kanali, shumë kanale (Root canal, multi) | 14,000 |     | Protezë totale (Complete denture)           | 45,000 |
| Ekstraksion dhëmbi (Tooth extraction)            |  3,000 |     | Protezë parciale (Partial denture)          | 35,000 |
| Ekstraksion kirurgjikal (Surgical extraction)    |  8,000 |     | Pllakë nate (Night guard)                   | 10,000 |
| Trajtim periodontal (Periodontal treatment)      |  8,000 |     | Aparat retencioni (Retainer)                | 12,000 |

The currency architecture is unchanged. The clinic's currency comes from `clinic_settings`, and the demo sets it to ALL.

## 10. Demo data and financial reset

`apps/api/scripts/seed-demo.js` was rewritten. It **plans the whole clinic in memory, then writes the same rows the API writes**:

- a visit → a completed appointment;
- that appointment's work → a clinical procedure, a chart finding, and an invoice with its lines and a ledger charge;
- a payment → the payment, a negative ledger entry and the invoice status;
- a cash payment → also a drawer event in that day's session;
- each day → a count, a review and a close.

**The old seed did not reconcile.** It wrote EUR invoices with no `subtotal` and **no ledger entries**, so every patient's balance read 0 while their invoices said they owed. It also seeded no rooms, stock or drawer. The new seed checks itself before it prints its summary: it throws if the invoices' outstanding total differs from the sum of the ledgers.

**What the demo holds** (reset on 2026-09-27; the numbers move with "today"):

|                      |                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Clinic               | exactly one, **DentalCare Demo Clinic** (`demo`)                                                               |
| Team                 | owner, 3 dentists (each with a home room), 1 receptionist                                                      |
| Patients             | 300 (10 scripted, the rest generated)                                                                          |
| Appointments         | 1,463 over ten weeks back and three ahead: 1,060 completed, 250 scheduled, 90 cancelled, 63 no-shows; 17 today |
| Invoices             | 971: 924 paid, 30 partially paid, 17 unpaid                                                                    |
| Invoiced / collected | 7,746,000 L / 7,012,500 L                                                                                      |
| Outstanding          | 733,500 L = the sum of 46 patients' ledger balances                                                            |
| Treatment plans      | 4 (in progress, completed, two proposed)                                                                       |

Invoices, payments and expenses by month:

| Month                    |    Invoiced |   Collected |    Expenses |
| ------------------------ | ----------: | ----------: | ----------: |
| Jul 2026 (from the 19th) | 1,371,000 L | 1,070,000 L |   824,000 L |
| Aug 2026                 | 3,270,000 L | 3,220,000 L | 1,107,000 L |
| Sep 2026 (to the 27th)   | 3,105,000 L | 2,722,500 L |   962,000 L |

**Expenses:**

- rent, utilities, materials and other running costs;
- **lab costs derived from the crowns, abutments and appliances actually billed that month**;
- **payroll** as one "salaries" expense per month, matching the per-person salary log.

**Checked on the throwaway database:**

- **0 of 291** billed patients have an invoice balance that differs from their ledger balance.
- Gentian Meta's invoice is exactly **50,000 L billed, 30,000 L paid, 20,000 L outstanding**.

**The reset itself.** `npm run demo:reset` is `reset-demo`, then `seed`.

- It removes **every clinic** in the target database, printing their names first, and loads the one demo clinic. That is how the Control Center ends up with exactly one.
- The old reset could not complete once any cash-drawer or record-access row existed: those tables refuse TRUNCATE, and only the audit log's guard was lifted. It now finds every `*_no_truncate` guard by name, and lifts and restores them inside the transaction.

## 11. Settings changes

These are covered in §2 and §3. In short:

- **Four groups:** Clinic (profile, opening hours, staff & doctors, rooms, services & prices), Payments (payments & tax, cash drawer, fiscalization), Communication (WhatsApp & reminders), System (modules, security).
- The cash drawer's rules have their own section, instead of sitting under "Features", which is now called "Modules".
- Old `?tab=` links still work.

## 12. Control Center

- The console shows exactly one clinic:
  - **DentalCare Demo Clinic** — Active;
  - Professional plan on a 30-day trial;
  - 5 staff;
  - aggregate counts only (patients, appointments, invoices, storage). It shows no clinical records.
- **No console code changed.** The one-clinic state is a property of the demo database.

## 13. Global search

- There is one box in the top bar on desktop, and one button on phones.
- **Patients first:** up to 6. Then **invoices**, up to 3, when the text looks like an invoice number ("INV-069", "inv 69"). Invoices appear only for staff with `invoices:read`.
- Keyboard: **/** or **Ctrl/⌘ K** focuses it; arrows move; Enter opens; Escape closes.
- Appointments and treatments are reached through the patient. A general search engine was deliberately not built.

## 14. Responsive fixes

**Final audit.** Every tenant route was loaded in headless Chrome as the owner, at 320 / 375 / 390 / 414 / 768 / 1024 / 1280 / 1440 px. The audit measures document overflow, `.content` overflow, and any element past the viewport edge that is not inside its own scroller.

- **0** route/width combinations overflow, on the dev server and on the production build served by `vite preview`. The receptionist run covered 375, 414, 768 and 1280 px; the owner run covered 320, 390, 1024 and 1440 px.
- Before this pass, Financials overflowed by 102 px at 320 px and by 32 px at 390 px, and the phone header had no brand on any route.

**Fixed:**

- the phone header (brand, search);
- Financials' range switcher;
- Inventory's filters and table;
- the Services table;
- the Settings navigation;
- the tall Today rows;
- the section tab row losing its active tab off-screen.

## 15. Accessibility

- **axe-core, WCAG 2 A/AA: 0 violations.** It was run as the owner at 1280 px on 18 routes, as reception at 390 px on 5, and as a dentist at 390 px on 3. That includes every screen changed here.
  - One real finding was fixed: the inventory alert bar's detail line was faded to 85% opacity, below 4.5:1 on the warning tint.
- New controls are real buttons and links with names:
  - Stock in and Stock out carry the item name in their `aria-label`;
  - each More menu is named per row;
  - the settings rows are buttons or links;
  - the search Cancel is a button;
  - invoice search results are `role="option"` entries in the existing listbox.
- **Touch targets:** 44 px minimum (settings and services rows are 56 px, tab bar items 52 px).
- **Motion:** the tab marker and the search overlay honour `prefers-reduced-motion`. So does everything else, through the existing global rule.

## 16. Performance

**Code splitting.** Before, every screen was in one chunk. Now the first download is the shell, sign-in and the dashboard, and each other screen arrives the first time it is opened, then stays cached.

- Main chunk: about **499 kB → 327 kB** (103 kB gzip).
- The patient record (109 kB) and the calendar (41 kB) load on first open.

How it works: one `Suspense` inside the layout keeps the sidebar, header and tab bar in place while a screen loads. Print routes have their own.

**No extra requests.** The patient timeline reuses the ledger response the header already fetched.

**Search is lighter.** It returns ranked, shorter result sets, and invoice lookups run only for invoice-shaped text.

## 17. Remaining issues

1. **Calendar week and day grid:** still no drag-to-move. The blocks still show a "Scheduled" pill on every booking.
2. **Browser-zone dates** remain in a few list columns, such as the patient list's "Registered" date and admin-web's greeting and trial time. They are correct for anyone whose computer is on Albanian time.
3. **Format baseline:** `format:check` reports 40 files. None were introduced here: 31 were already failing before this pass, and 9 are other pending working-tree changes (storage, usage, tenant routes, the vite and compose files). Every file this pass owns is Prettier-clean.
   - **Line endings:** on Windows, earlier Python-based edits had written CRLF into several LF files. The files this pass touched were converted back to LF; git's `autocrlf` hid the difference in `git diff`.
4. **Demo realism:**
   - The clinic opens on weekends, so a demo on any day has a "today".
   - All services are TVSH-exempt, which keeps the demo invoices free of tax. Whitening and veneers would normally be taxed.
   - Patient phone numbers are random numbers in the Albanian format. No messages are sent: reminders go to the log channel, and nobody has WhatsApp consent.
5. **Search:** "See all patients matching …" also appears when only invoices matched.
6. **Payment methods:** the payment sheet offers Cash · Card · Bank transfer (the clinic's configured methods). A literal "Other" is not added.
7. **Owner-only pages reached by URL.** A receptionist who types `/financials`, `/reports` or `/activity` into the address bar gets pages whose API calls are refused with 403. Their navigation never offers these pages, and the API is the real boundary. The pages should still show the "Administrator access only" state that Settings already shows.

## 18. Production blockers

These are not caused by this pass, and not fixed by it. They are carried from [PRE_PRODUCTION_BASELINE.md](./PRE_PRODUCTION_BASELINE.md) and the Cloudflare notes:

- **Runtime and Hyperdrive.** The Workers dry-run bundles and binds (3.6 MB, 941 kB gzip), but a real Hyperdrive connection and caching behaviour are still unverified against a live database.
- **Fiscalization.** The demo uses `default_checkout_mode = internal`. A real clinic needs its CIS certificate and TCR codes configured, and a successful registration in the tax authority's test environment, before go-live.
- **Messaging providers.** Twilio / WhatsApp Cloud / Vonage credentials are not configured anywhere, and delivery is unverified.
- **The demo scripts in a production image.** Decide whether `seed-demo.js` and `reset-demo.js` ship. They now refuse to run without `DEMO_ENV=true`, which nothing sets by default, but they still exist.
- **The branch.** Everything is uncommitted on `preserve/pre-production-sept-9-18`, alongside the previous passes' pending work, and needs review and commit before any deploy.
