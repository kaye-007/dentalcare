/**
 * 0006 — money in minor units, one currency per clinic, and a payer
 *
 * ── Minor units ───────────────────────────────────────────────────────────
 *
 * Every money column was an integer of WHOLE units: 45 meant €45, and €37.50
 * could not be stored. VAT was rounded per line to the euro. This multiplies
 * every money column by 100, in place, so every stored integer becomes cents.
 * Nothing changes value: €45 was 45 and is now 4500.
 *
 * The columns stay `integer`. In cents that caps a single row at about €21
 * million, which no dental invoice approaches, and it keeps node-postgres
 * returning numbers rather than the strings it returns for bigint. Sums are
 * bigint in SQL already and are converted where they are read.
 *
 * Rows already in clinic_audit_log keep the amounts they were written with,
 * in whole units. That table cannot be rewritten by design, and rewriting
 * evidence to match a new unit would be worse than a unit change on a date.
 * Entries written after this migration say which currency they are in.
 *
 * ── One currency per clinic ───────────────────────────────────────────────
 *
 * invoices.currency and ledger_entries.currency could each hold any of five
 * currencies per row, defaulting to EUR, while clinic_settings.currency said
 * something else again. Invoices raised from a treatment plan took the
 * clinic's currency; ad-hoc invoices and every payment took the column
 * default. A lek-denominated clinic ended up with both, and every report
 * summed them together.
 *
 *   - Every new invoice and ledger row takes its clinic's currency, whatever
 *     the application sends (trigger).
 *   - A recorded amount's currency never changes (same trigger).
 *   - A clinic's currency cannot change once it has recorded a price or any
 *     money, because every stored integer would silently change meaning
 *     (trigger on clinic_settings).
 *
 * The migration refuses to run if any clinic ALREADY holds money in more than
 * one currency, and names them: which figures were meant in which currency is
 * a question for the clinic, not for a migration.
 *
 * ── Payer ─────────────────────────────────────────────────────────────────
 *
 * invoices and ledger_entries gain `payer_type` (patient | insurer |
 * guarantor, default patient) and `payer_reference`. Nothing uses them yet.
 * They exist because the day an insurer pays part of a bill, "who owes this"
 * has to be a column on the row that records it, and adding that to a ledger
 * with history is much harder than adding it now.
 *
 * ── Row-level security during the migration ───────────────────────────────
 *
 * Every tenant table here is FORCE RLS, which binds the migrating owner role
 * too: with no tenant in context, an UPDATE would match NO rows and the
 * migration would report success having converted nothing. Each table is
 * therefore switched to NO FORCE for the length of this transaction and back
 * to FORCE before it commits. The same applies to the consistency check,
 * which would otherwise see no rows and pass on a database that should fail.
 */

exports.shorthands = undefined;

/** table -> money columns. `rls`: whether the table is FORCE RLS. */
const MONEY = [
  { table: 'clinical_procedures', columns: ['fee'], rls: true },
  { table: 'expenses', columns: ['amount'], rls: true },
  {
    table: 'invoice_line_items',
    columns: ['unit_price', 'amount', 'discount_amount', 'tax_amount'],
    rls: true,
  },
  { table: 'invoices', columns: ['subtotal', 'discount_amount', 'tax_amount', 'total'], rls: true },
  { table: 'ledger_entries', columns: ['amount'], rls: true },
  { table: 'payments', columns: ['amount'], rls: true },
  { table: 'plans', columns: ['price_monthly'], rls: false },
  { table: 'procedure_codes', columns: ['default_fee'], rls: true },
  { table: 'salary_payments', columns: ['amount'], rls: true },
  { table: 'treatment_plan_items', columns: ['unit_fee', 'discount_amount'], rls: true },
  { table: 'treatment_plans', columns: ['discount_amount'], rls: true },
  { table: 'treatments', columns: ['price'], rls: true },
  { table: 'users', columns: ['salary_amount'], rls: true },
];

/** Tables read by the consistency check that are FORCE RLS but hold no money. */
const ALSO_UNFORCED = ['tenants', 'clinic_settings'];

/**
 * Record guards from 0004 refuse any edit to a signed or billed procedure —
 * which includes multiplying its fee by 100. They are off only for this
 * statement and back on before commit.
 */
const GUARDED = [
  ['clinical_procedures', 'clinical_procedures_record_guard'],
  ['clinical_procedures', 'clinical_procedures_billing_guard'],
];

const unforce = (tables) => tables.map((t) => `ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;`).join('\n');
const force = (tables) => tables.map((t) => `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`).join('\n');

const rlsTables = [...MONEY.filter((m) => m.rls).map((m) => m.table), ...ALSO_UNFORCED];

const scale = (op) =>
  MONEY.map(
    ({ table, columns }) =>
      `UPDATE ${table} SET ${columns.map((c) => `${c} = ${c} ${op} 100`).join(', ')};`,
  ).join('\n');

const comments = MONEY.flatMap(({ table, columns }) =>
  columns.map(
    (c) =>
      `COMMENT ON COLUMN ${table}.${c} IS 'Money: integer minor units (cents) of the clinic currency. Migration 0006.';`,
  ),
).join('\n');

const UP = `
${unforce(rlsTables)}

-- ── refuse a clinic that already mixes currencies ────────────────────────
DO $$
DECLARE
  mixed text;
BEGIN
  SELECT string_agg(DISTINCT t.subdomain, ', ' ORDER BY t.subdomain) INTO mixed
    FROM (SELECT tenant_id, currency FROM invoices
          UNION
          SELECT tenant_id, currency FROM ledger_entries) m
    JOIN tenants t ON t.id = m.tenant_id
    LEFT JOIN clinic_settings cs ON cs.tenant_id = m.tenant_id
   WHERE m.currency <> coalesce(cs.currency, 'EUR');
  IF mixed IS NOT NULL THEN
    RAISE EXCEPTION 'These clinics hold money in a currency other than their clinic currency: %. Decide which currency those figures were meant in and correct them before running 0006.', mixed;
  END IF;
END $$;

-- ── whole units -> minor units ───────────────────────────────────────────
${GUARDED.map(([t, g]) => `ALTER TABLE ${t} DISABLE TRIGGER ${g};`).join('\n')}
${scale('*')}
${GUARDED.map(([t, g]) => `ALTER TABLE ${t} ENABLE TRIGGER ${g};`).join('\n')}

${comments}

-- ── one currency per clinic ──────────────────────────────────────────────
CREATE FUNCTION clinic_currency_of(p_tenant uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT currency FROM clinic_settings WHERE tenant_id = p_tenant), 'EUR')
$$;

CREATE FUNCTION money_currency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.currency := clinic_currency_of(NEW.tenant_id);
  ELSIF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'The currency of a recorded amount cannot change'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invoices_currency_guard
  BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION money_currency_guard();
CREATE TRIGGER ledger_entries_currency_guard
  BEFORE INSERT OR UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION money_currency_guard();

CREATE FUNCTION clinic_currency_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.currency ELSE 'EUR' END;
BEGIN
  IF NEW.currency IS DISTINCT FROM previous AND (
       EXISTS (SELECT 1 FROM invoices        WHERE tenant_id = NEW.tenant_id)
    OR EXISTS (SELECT 1 FROM ledger_entries  WHERE tenant_id = NEW.tenant_id)
    OR EXISTS (SELECT 1 FROM expenses        WHERE tenant_id = NEW.tenant_id)
    OR EXISTS (SELECT 1 FROM salary_payments WHERE tenant_id = NEW.tenant_id)
    OR EXISTS (SELECT 1 FROM treatments      WHERE tenant_id = NEW.tenant_id AND price > 0)
    OR EXISTS (SELECT 1 FROM procedure_codes WHERE tenant_id = NEW.tenant_id AND default_fee > 0)
    OR EXISTS (SELECT 1 FROM users           WHERE tenant_id = NEW.tenant_id AND salary_amount IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'The clinic currency cannot change once prices or money have been recorded in it'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER clinic_settings_currency_lock
  BEFORE INSERT OR UPDATE OF currency ON clinic_settings
  FOR EACH ROW EXECUTE FUNCTION clinic_currency_lock();

-- ── who pays ─────────────────────────────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN payer_type text NOT NULL DEFAULT 'patient',
  ADD COLUMN payer_reference text,
  ADD CONSTRAINT invoices_payer_known CHECK (payer_type IN ('patient', 'insurer', 'guarantor'));

ALTER TABLE ledger_entries
  ADD COLUMN payer_type text NOT NULL DEFAULT 'patient',
  ADD COLUMN payer_reference text,
  ADD CONSTRAINT ledger_entries_payer_known CHECK (payer_type IN ('patient', 'insurer', 'guarantor'));

${force(rlsTables)}
`;

const DOWN = `
${unforce(rlsTables)}

-- Cents that do not divide back into whole units would be lost. Refuse.
DO $$
BEGIN
  IF ${MONEY.flatMap(({ table, columns }) =>
    columns.map((c) => `EXISTS (SELECT 1 FROM ${table} WHERE ${c} % 100 <> 0)`),
  ).join('\n     OR ')} THEN
    RAISE EXCEPTION 'Some amounts have cents; rolling back to whole units would lose them.';
  END IF;
END $$;

ALTER TABLE ledger_entries DROP COLUMN payer_reference, DROP COLUMN payer_type;
ALTER TABLE invoices DROP COLUMN payer_reference, DROP COLUMN payer_type;

DROP TRIGGER IF EXISTS clinic_settings_currency_lock ON clinic_settings;
DROP FUNCTION IF EXISTS clinic_currency_lock();
DROP TRIGGER IF EXISTS ledger_entries_currency_guard ON ledger_entries;
DROP TRIGGER IF EXISTS invoices_currency_guard ON invoices;
DROP FUNCTION IF EXISTS money_currency_guard();
DROP FUNCTION IF EXISTS clinic_currency_of(uuid);

${GUARDED.map(([t, g]) => `ALTER TABLE ${t} DISABLE TRIGGER ${g};`).join('\n')}
${scale('/')}
${GUARDED.map(([t, g]) => `ALTER TABLE ${t} ENABLE TRIGGER ${g};`).join('\n')}

${force(rlsTables)}
`;

exports.up = (pgm) => {
  pgm.sql(UP);
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
