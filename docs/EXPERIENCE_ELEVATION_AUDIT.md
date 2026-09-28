# DentalCare — experience elevation audit

Date: 2026-09-27 · Follows [PRODUCT_POLISH_COMPLETE.md](./PRODUCT_POLISH_COMPLETE.md)

**Method.** Every major screen was rendered from the production build against the seeded demo clinic, as the owner at 1440 px and 390 px. Full-page screenshots were read one by one.

**Scope agreed with the owner:** keep the Ink & Ember identity (colours, type, the warm character), and cut the noise that hurts hierarchy. Every visual change is listed in the completion document so it can be vetoed.

**Page-level horizontal overflow: none** on any audited route at 390 or 1440 px. The measured culprit list (elements past the edge outside an intended scroller) is also empty. The phone header shows the logo and clinic name, and the tab bar is fixed with five destinations.

The problems are not layout breakage. They are **hierarchy and noise**.

---

## 1. The biggest finding: normal states shout

The application paints the **expected, finished state** with the same saturated pill as the exceptions:

| Screen                  | What repeats on (almost) every row      | What actually needs the eye |
| ----------------------- | --------------------------------------- | --------------------------- |
| Dashboard › Today       | green "Completed"                       | No-show, in the chair       |
| Clinical › Today        | green "Completed" (13 of 14 rows)       | the one No-show             |
| Invoices                | green "Paid" (≈ 90 % of rows)           | Unpaid, Partial             |
| Cash drawer › Past days | green "Closed" **and** green "Balanced" | "Short 500 L"               |
| Inventory               | green "In stock" (41 of 54 rows)        | Low stock, Out of stock     |
| Patient timeline        | green "Completed" / blue "Scheduled"    | nothing, usually            |

**Colour is supposed to be information.** Here it is wallpaper, and the one amber pill on a screen of forty green ones is hard to find.

**Fix:** one quiet treatment for finished states (a muted ✓ and a word, no fill), applied in the shared `StatusPill`. Exceptions keep their colour.

## 2. Screen by screen

### Dashboard (owner, desk)

- **Too long.** At 390 px the page is about 3,200 px tall.
  - _Coming up_ lists **all of tomorrow** (20 rows, each with a Call button) before anything else.
  - The recall line and the month's money sit under it, off every first screen.
- **Exceptions are scattered.** Low stock is a banner at the top, and recall is a line at the very bottom. They are the same kind of thing ("needs attention") in two places.
- **Visible buttons.** Every Today row has a Call icon button plus Bill or Check in or a pill, which makes 28–42 controls on one list.

### Patients

- **The columns answer the wrong question.** They are Patient (with email) · Phone · City · Registered. At the desk the questions are _when are they next in_ and _do they owe anything_. City and registration date are database facts.
- On a phone, each row is name + phone + city.

### Patient record

- **The header is good:** name, four actions, and phone · next · last · balance.
- **The right rail is three near-empty cards** (Allergies, Medical conditions, Medications), each about 130 px tall, saying "No … recorded". On a phone they add about 450 px of nothing.
- **Record access** (the admin's audit trail) is an open list under them. On a phone it runs past the tab bar. It is compliance information, not what a clinician opens the record for.
- The timeline repeats the "Completed" pill.

### Dental chart

- **Three toggle groups** sit in the card header on desktop: Arch/Surfaces, Adult/Pediatric and FDI/Universal. The last two are set once per patient; phones already fold them behind _View options_, but desktop does not.
- The empty **Periodontal charting** card takes about 250 px to say there are no exams.

### Calendar (week)

- Three dentists side by side in narrow day columns truncate every block to "Lo… 09:…". The block repeats the time the grid already shows.

### Invoices

- **A wrong figure.** The header says "200 in view · 419,500 L outstanding" while the clinic's real outstanding is 758,500 L. The number is the sum of the 200 rows loaded, presented as if it were the clinic's.
- A "0 L" balance and a green "Paid" on each settled row.

### Invoice

- Total / Paid / Balance are **three separate cards**: a card per number, not a grouping.

### Payment sheet

- Already the right shape (amount → method → one button → receipt state). The amount reads "20000 L" while it is being typed, without the group separator the rest of the app uses. This is kept: it is an input, and typing into a formatted number fights the cursor.

### Inventory

- **About 160 visible buttons.** Every row has Stock in, Stock out and a More menu.
- It is not glanceable: there is no "13 low · 2 out · 39 fine" read before the table.
- On a phone each item card is about 150 px tall because of its button row.

### Cash drawer

- The open-drawer card is right: one big number, Close drawer, Take cash out.
- **Past days:** two green pills per row, plus a Flags column that is "—" on every row.

### Settings

- The grouping is good (Clinic · Payments · Communication · System, with a one-line hint on phones).
- The brand-colour control is a full-width colour bar, which is decoration.

### Control Center

- One clinic, as intended. It was reworked in an earlier pass and is not changed here.

## 3. What is already right and stays

- The phone shell: fixed compact header with the logo, five fixed tabs, safe areas, and no sideways page scroll.
- The patient header's four primary actions, and the facts row.
- The payment sheet and its receipt state; the cash drawer's open card.
- Search (phones forgive trunk 0 and +355; Ctrl/⌘ K; patients first).
- The Ink & Ember palette, typography and warm background.

## 4. Planned changes

1. **Quiet finished states**, app-wide (`StatusPill` kind `done`): Completed, Paid, Closed, Balanced, In stock.
2. **Dashboard:** one _Needs attention_ block (stock, expiring lots, recall) right under the day's figures. Tomorrow shows its first 5 with "Show all". Finished visits recede.
3. **Patients:** Patient · Phone · Next visit · Balance (balance only for roles that may see money). On a phone: name, next visit and balance. **Needs two read-only fields on the existing list endpoint; no schema change.**
4. **Patient record:** the three medical cards become one _Medical history_ card when they are empty; allergies stay loud when present. _Record access_ folds behind a disclosure.
5. **Dental chart:** Adult/Pediatric and FDI/Universal go behind _View options_ on desktop too. Empty perio becomes one line.
6. **Inventory:** a glance line (low · out · fine) that doubles as the filter. Rows show **Stock in** only, with Stock out moved into the row's menu.
7. **Invoices:** the header shows the clinic's real outstanding; settled balances read "—". **Invoice:** one summary band instead of three cards.
8. **Cash drawer:** past days drop the always-"—" Flags column and the redundant "Closed".
9. **Calendar week:** a block no longer repeats its start time where it only has room for one thing; the patient name gets the space.
