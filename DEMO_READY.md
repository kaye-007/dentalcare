# Demo Readiness — UX & QA Pass

Product-design and QA review of the clinic application ahead of the first
public demonstration. Every page opened, every workflow followed, against a
live database with the demo clinic loaded.

**No business logic was changed.** Everything here is presentation, copy,
accessibility, or demo-data realism.

---

## How this was tested

Driven through a real browser against the running API and a freshly seeded
database — login, navigation, every page, mobile viewport, console, network.

**One honest caveat:** the browser pane in this environment would not
composite frames, so screenshots were unavailable. Findings come from the
accessibility tree, rendered text, computed styles, layout measurements,
console and network logs — not from looking at pixels. That reliably catches
structure, copy, spacing, contrast values, overflow, focus order and console
health. It does **not** reliably catch purely optical problems: a slightly
misaligned icon, an awkward shadow, a colour that technically passes contrast
but looks wrong. **A human should still do one visual pass before the demo.**

---

## Critical — the product was broken on mobile

### 1. No navigation at all on a phone

Below 760px the sidebar was `display: none` with nothing replacing it. Zero
navigation links were reachable — a dentist opening the app on their phone
landed on one page and could never leave it. No hamburger, no bottom bar, no
menu of any kind.

**Fixed.** The sidebar is now an off-canvas drawer: topbar toggle, dimming
scrim, Escape to close, and it closes automatically on route change so tapping
a destination doesn't leave the menu covering the page it just opened.

Verified: all 10 destinations reachable at 375px.

### 2. Half of every table was invisible

Tables sat inside `.card`, which has `overflow: hidden`. At 375px the table
measured 659px against a 318px container — phone, email, city and status
columns were clipped with no way to scroll to them.

**Fixed.** Cards scroll horizontally on mobile with a table `min-width`, so
columns stay legible rather than being crushed or cut.

---

## Legibility

### 3. Currency read as the wrong number

`de-DE` formatting produced **"1.200 €"** inside a UI that is English
throughout (en-GB dates like "Thursday 6 August"). To an English-speaking
reader "1.200" is one-point-two. On a treatment catalogue that is a
120,000% error in perception.

**Fixed.** `en-IE` — English-language euro formatting: **"€1,200"**.
Symbol-first, comma grouping, unambiguous.

### 4. Every clinician's avatar showed the same initials

`initials()` took the first letter of the first word, so "Dr. Lukas Brandt"
became **DB**, "Dr. Sofia Ricci" **DR**, "Dr. Julien Moreau" **DM** — three
dentists all starting with D, differing only in the second letter.

**Fixed.** Honorifics (Dr., Prof., Mr, Mrs, Ms, Mx) are stripped first:
**LB, SR, JM**.

---

## Demo data realism

These are the details a practice manager notices in the first two minutes,
and each one says "this is fake".

### 5. Payments dated in the future

The payments list showed **9 Aug and 8 Aug** when the demo date was 6 Aug.
Settlement offsets were pushing recent invoices past today.

**Fixed.** Payment timestamps are clamped to just before now. Verified: zero
future-dated payments.

### 6. Invoice numbers ran out of order against their dates

INV-0140 dated 21 May sat above INV-0138 dated 13 July. Invoice numbers that
don't track issue dates are the first thing anyone who has run a practice will
question.

**Fixed.** Issue dates are generated and sorted before numbering, so the
sequence increases with date. Verified: INV-0140 → 5 Aug, INV-0139 → 3 Aug,
INV-0138 → 3 Aug, INV-0137 → 2 Aug.

### 7. All 25 patients "Registered today"

Every patient row read the same date — unmistakably a generated dataset.

**Fixed.** Registration spread across ~18 months (Feb 2025 – Jul 2026).

### 8. Every payment timestamped exactly 12:00

130 payments, one distinct time.

**Fixed.** Times now vary across the working day — 51 distinct values.

### 9. Phone numbers were visibly arithmetic

`+43 668 100 1000`, `+43 699 103 1007`, `+43 671 106 1014` — the pattern is
obvious reading down the column.

**Fixed.** Fully randomised.

### 10. The same patient booked in consecutive slots

Pieter van Dijk appeared at 08:00, 08:30 and 09:00 on one day.

**Fixed.** No patient is booked twice in the same day.

---

## Affordances and copy

### 11. A search box that did nothing

The topbar search had no `onChange`, no handler, no state — typing in it did
nothing at all. A control that looks functional and isn't is worse than no
control: a dentist will try it within thirty seconds.

**Removed**, along with its dead CSS. (It was also the only unlabelled input
on the page, so this closed an accessibility issue too.) Wiring it to real
search is a feature, and belongs in its own change.

### 12. Placeholder pluralisation

"6 member(s)", "130 payment(s)", "25 new patient(s)", "12 record(s)" — the
`(s)` construction reads as unfinished software.

**Fixed** via a shared `plural()` helper: "6 team members", "130 payments",
"25 new patients", "12 records across 8 teeth".

### 13. Mixed English spelling

"catalog" (US) sat alongside "Paediatric", "Thursday 6 August" and other en-GB
copy.

**Fixed** → "catalogue", consistently.

### 14. Leftover Albanian-market placeholders

Email placeholders still read `you@clinic.al`, `info@clinic.al`,
`name@clinic.al` from before the product was repositioned for Europe.

**Fixed** → `.com`.

---

## Accessibility

### 15. Icon-only buttons had no accessible name

Sign out, reminder log, calendar previous/next carried only `title`, which
screen readers treat inconsistently.

**Fixed.** Explicit `aria-label` on each, plus `aria-expanded` on the new
navigation toggle.

### 16. Off-screen drawer stayed in the tab order

An off-canvas panel moved only by `transform` is still focusable — tabbing
from the topbar would walk through ten invisible navigation links.

**Fixed.** The closed drawer is `visibility: hidden`, with the transition
sequenced so it still animates.

### Already correct — checked and left alone

- `html lang="en"` set
- Zero images without `alt`
- `:focus-visible` outlines defined globally
- `prefers-reduced-motion` respected (and the new drawer honours it)
- All form inputs wrapped in `<label>`
- Heading hierarchy sane (single `h1` per page)

---

## Console

### 17. Two React Router startup warnings

`v7_startTransition` and `v7_relativeSplatPath` future-flag warnings fired on
every page load.

**Fixed** by opting in. Console is now clean on load: no errors, no warnings.

---

## Checked and found already good

Worth recording so the demo script can lean on them.

| Area | State |
|---|---|
| Empty states | Present on all 10 pages via a shared `EmptyState`, with icon, title, explanatory body and a call to action |
| Loading states | Consistent `…` placeholders; no layout jump on load |
| Success feedback | Settings shows "Saving…" → "✓ Saved"; forms disable during submit |
| Error handling | API errors surface the server message; login failures render inline |
| Status colours | One semantic pill system (ok/info/warn/danger/neutral) used consistently across appointments, patients, invoices |
| Spacing | Single token scale (`--row-pad-x/y`, `--radius`) applied uniformly |
| Modals | One shared `Modal`; overlay click and stop-propagation handled |
| Role gating | Frontdesk sees no Staff, Reports or Settings; enforced server-side too |
| Reports | Six-month trend, four breakdowns, all populated and plausible |
| Dashboard | Live data throughout — no placeholder widgets remain |

---

## Known issues left open

Deliberate calls, not oversights.

| Issue | Why it was left |
|---|---|
| **A human visual pass is still needed** | See the caveat above — optical alignment and colour judgement could not be verified without rendered frames. This is the one item I would not skip. |
| Global search not implemented | Removing the dead control was the honest fix; building search is a feature, not polish. |
| `…` loading rather than skeletons | Consistent and calm. Skeletons are a design project, not a demo blocker. |
| Reports "Mar" column reads zero | The demo has 120 days of invoices against a six-month default range. Real, not a rendering fault. Widen the seed window if it bothers you on stage. |
| Calendar shows empty Sat/Sun | The demo clinic is closed at weekends, correctly reflected. Hiding closed days is a product decision. |
| Treatment prices prefixed "from" | Pre-existing copy, defensible for a catalogue. Left as-is rather than changing meaning. |

---

## Verification

```
npm test -w @dentalcare/api     47 passed, 4 suites
npm run api:build               clean
npm run web:build               1594 modules, 278.50 kB (79.56 kB gzip)
npm run admin:build             1580 modules, 181.08 kB (57.83 kB gzip)
```

Browser: login, dashboard, patients, treatments, staff, invoices, payments,
expenses, reports, settings, reservations — all render with real data. Mobile
drawer opens, closes via scrim, and exposes all 10 destinations. Tables scroll.
No horizontal page overflow at 375px. Console clean.

Database: zero future-dated payments, invoice numbers ordered by date,
patient registrations spread over 18 months, 51 distinct payment times.

---

## Verdict

The two mobile findings were the difference between "polished product" and
"obviously unfinished" — a dentist pulling this up on a phone would have hit a
dead end immediately. Those are fixed, along with the currency formatting and
the handful of data details that betrayed generated content.

**Ready to demonstrate**, with one caveat: get a human to look at it once, on
a real screen, before you present. Everything structural has been verified;
the last 5% is optical and I could not see it.
