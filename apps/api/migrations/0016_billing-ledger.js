/**
 * 0016 — billing: currency, VAT, ledger, and plan-driven invoicing
 *
 *   clinic_settings      : + currency, + vat_rate_bp
 *   treatments           : + is_taxable
 *   procedure_codes      : + is_taxable
 *   invoices             : + treatment_plan_id, subtotal, discount, tax,
 *                          currency, vat_rate_bp, due_on, notes, cancelled_*
 *   invoice_line_items   : + discount, tax rate/amount, links back to the plan
 *                          line, the procedure, and the tooth
 *   ledger_entries       : append-only record of every money event
 *
 * WHAT THIS MIGRATION DELIBERATELY DOES NOT ADD
 *
 * No insurance. Confirmed twice: this build targets the Albanian market, where
 * the patient pays the clinic directly. Payment methods stay cash / card /
 * bank, and there is no claims table. Modelling a claim lifecycle nobody
 * submits would be dead schema that still has to be maintained.
 *
 * No exchange rates. Currency is ONE setting per clinic, stamped onto each
 * invoice so a later settings change cannot retroactively reprice history.
 * Nothing converts between currencies anywhere, so a stored integer means the
 * same thing for the whole life of a clinic's data.
 *
 * VAT DEFAULTS TO ZERO. Medical services are generally VAT-exempt, and the
 * safe default is to charge nothing until a clinic's accountant says
 * otherwise. Taxability is per-treatment so exempt and taxable services can
 * coexist on one invoice.
 *
 * Rates are BASIS POINTS: 20% is 2000. Integer percent cannot express 8.5%,
 * and a float would reintroduce the rounding the money model avoids.
 */

exports.shorthands = undefined;

const RLS = (pgm, table) => {
  pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`CREATE POLICY tenant_isolation ON ${table}
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);
};

exports.up = (pgm) => {
  /* ── 1. clinic currency and VAT ───────────────────────────────────── */
  pgm.addColumns('clinic_settings', {
    currency: { type: 'text', notNull: true, default: 'EUR' },
    /** Basis points. 0 = exempt, which is the default for medical services. */
    vat_rate_bp: { type: 'integer', notNull: true, default: 0 },
    /** Printed on invoices where a jurisdiction requires it. */
    tax_number: { type: 'text' },
    /** Days until an invoice is due. 0 = payable on issue. */
    payment_terms_days: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.sql(`ALTER TABLE clinic_settings ADD CONSTRAINT cs_currency_valid
             CHECK (currency IN ('EUR','ALL','USD','GBP','CHF'));`);
  pgm.sql(`ALTER TABLE clinic_settings ADD CONSTRAINT cs_vat_rate_valid
             CHECK (vat_rate_bp BETWEEN 0 AND 10000);`);
  pgm.sql(`ALTER TABLE clinic_settings ADD CONSTRAINT cs_payment_terms_valid
             CHECK (payment_terms_days BETWEEN 0 AND 365);`);

  /* ── 2. taxability lives on the service, not the invoice ──────────── */
  pgm.addColumns('treatments', {
    is_taxable: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addColumns('procedure_codes', {
    is_taxable: { type: 'boolean', notNull: true, default: false },
  });

  /* ── 3. invoices ──────────────────────────────────────────────────── */
  pgm.addColumns('invoices', {
    treatment_plan_id: {
      type: 'uuid', references: 'treatment_plans', onDelete: 'SET NULL',
    },
    subtotal: { type: 'integer', notNull: true, default: 0 },
    discount_amount: { type: 'integer', notNull: true, default: 0 },
    tax_amount: { type: 'integer', notNull: true, default: 0 },
    /**
     * Stamped at issue. The clinic's currency setting can change; an invoice
     * already given to a patient must not silently change denomination.
     */
    currency: { type: 'text', notNull: true, default: 'EUR' },
    vat_rate_bp: { type: 'integer', notNull: true, default: 0 },
    due_on: { type: 'date' },
    notes: { type: 'text' },
    cancelled_at: { type: 'timestamptz' },
    cancel_reason: { type: 'text' },
  });
  pgm.sql(`ALTER TABLE invoices ADD CONSTRAINT invoice_amounts_sane
             CHECK (subtotal >= 0 AND discount_amount >= 0
                    AND tax_amount >= 0 AND total >= 0);`);
  pgm.sql(`ALTER TABLE invoices ADD CONSTRAINT invoice_currency_valid
             CHECK (currency IN ('EUR','ALL','USD','GBP','CHF'));`);
  pgm.sql(`ALTER TABLE invoices ADD CONSTRAINT invoice_cancel_consistent
             CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));`);
  pgm.createIndex('invoices', ['tenant_id', 'issued_at']);
  pgm.createIndex('invoices', ['tenant_id', 'treatment_plan_id']);

  /* ── 4. invoice lines ─────────────────────────────────────────────── */
  pgm.addColumns('invoice_line_items', {
    discount_amount: { type: 'integer', notNull: true, default: 0 },
    tax_rate_bp: { type: 'integer', notNull: true, default: 0 },
    tax_amount: { type: 'integer', notNull: true, default: 0 },
    /** Where this line came from, so a plan line cannot be billed twice. */
    plan_item_id: {
      type: 'uuid', references: 'treatment_plan_items', onDelete: 'SET NULL',
    },
    procedure_id: {
      type: 'uuid', references: 'clinical_procedures', onDelete: 'SET NULL',
    },
    procedure_code_id: {
      type: 'uuid', references: 'procedure_codes', onDelete: 'SET NULL',
    },
    tooth: { type: 'smallint' },
    sort_order: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.sql(`ALTER TABLE invoice_line_items ADD CONSTRAINT ili_amounts_sane
             CHECK (unit_price >= 0 AND amount >= 0
                    AND discount_amount >= 0 AND tax_amount >= 0);`);
  pgm.sql(`ALTER TABLE invoice_line_items ADD CONSTRAINT ili_discount_bounded
             CHECK (discount_amount <= unit_price * quantity);`);
  pgm.sql(`ALTER TABLE invoice_line_items ADD CONSTRAINT ili_tax_rate_valid
             CHECK (tax_rate_bp BETWEEN 0 AND 10000);`);
  // A treatment-plan line can be billed exactly once. This is the guard
  // against a clinic invoicing the same work twice by regenerating a plan
  // invoice — the database refuses rather than trusting the caller to check.
  pgm.sql(`CREATE UNIQUE INDEX invoice_line_plan_item_unique
             ON invoice_line_items (plan_item_id) WHERE plan_item_id IS NOT NULL;`);

  /* ── 5. payments: a transaction reference ─────────────────────────────
     `note`, `created_by` and a positive-amount CHECK already exist from
     migration 0009 — created_by IS the person who took the payment, so a
     separate received_by would be the same fact stored twice. Only the
     external reference is genuinely missing. */
  pgm.addColumns('payments', {
    /** Card terminal slip, bank reference, receipt number. */
    reference: { type: 'text' },
  });

  /* ── 6. the ledger ────────────────────────────────────────────────────
     Append-only. Every money event is a row, signed so a patient's balance is
     the plain sum of their entries rather than a reconciliation between three
     tables. Rows are never updated or deleted: a correction is a new entry,
     which is what makes the ledger evidence rather than a cache. */
  pgm.createTable('ledger_entries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', references: 'invoices', onDelete: 'SET NULL' },
    payment_id: { type: 'uuid', references: 'payments', onDelete: 'SET NULL' },
    entry_type: {
      type: 'text',
      notNull: true,
      check: "entry_type IN ('charge','payment','adjustment','refund','write_off')",
    },
    /**
     * SIGNED. Positive increases what the patient owes, negative reduces it.
     * The service applies the sign from LEDGER_SIGN; storing it signed means
     * a balance is one SUM with no per-type logic.
     */
    amount: { type: 'integer', notNull: true },
    currency: { type: 'text', notNull: true, default: 'EUR' },
    description: { type: 'text', notNull: true },
    occurred_on: { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE ledger_entries ADD CONSTRAINT ledger_amount_nonzero
             CHECK (amount <> 0);`);
  pgm.sql(`ALTER TABLE ledger_entries ADD CONSTRAINT ledger_description_present
             CHECK (btrim(description) <> '');`);
  pgm.sql(`ALTER TABLE ledger_entries ADD CONSTRAINT ledger_currency_valid
             CHECK (currency IN ('EUR','ALL','USD','GBP','CHF'));`);
  pgm.createIndex('ledger_entries', ['tenant_id', 'patient_id', 'occurred_on']);
  pgm.createIndex('ledger_entries', ['tenant_id', 'occurred_on']);
  pgm.createIndex('ledger_entries', 'invoice_id');
  RLS(pgm, 'ledger_entries');

  /* ── 7. backfill existing invoices into the new columns ───────────── */
  // Pre-0016 invoices carried only a total, with no tax and no line discounts.
  // Their subtotal therefore equals their total, which is exactly true of a
  // tax-free invoice and keeps every historical figure unchanged.
  pgm.sql(`UPDATE invoices SET subtotal = total WHERE subtotal = 0 AND total <> 0;`);

  // Give every historical invoice and payment a ledger entry, so the ledger is
  // complete from the beginning rather than starting mid-history with balances
  // that disagree with the invoice list.
  pgm.sql(`
    INSERT INTO ledger_entries
      (tenant_id, patient_id, invoice_id, entry_type, amount, description, occurred_on, created_at)
    SELECT i.tenant_id, i.patient_id, i.id, 'charge', i.total,
           'Invoice ' || i.invoice_number, i.issued_at, i.created_at
      FROM invoices i
     WHERE i.status <> 'cancelled' AND i.total > 0;
  `);
  pgm.sql(`
    INSERT INTO ledger_entries
      (tenant_id, patient_id, invoice_id, payment_id, entry_type, amount,
       description, occurred_on, created_at)
    SELECT p.tenant_id, i.patient_id, p.invoice_id, p.id, 'payment', -p.amount,
           'Payment (' || p.method || ') for ' || i.invoice_number,
           p.paid_at::date, p.paid_at
      FROM payments p
      JOIN invoices i ON i.id = p.invoice_id;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('ledger_entries');

  pgm.dropColumns('payments', ['reference']);

  pgm.sql('DROP INDEX IF EXISTS invoice_line_plan_item_unique;');
  pgm.sql('ALTER TABLE invoice_line_items DROP CONSTRAINT IF EXISTS ili_tax_rate_valid;');
  pgm.sql('ALTER TABLE invoice_line_items DROP CONSTRAINT IF EXISTS ili_discount_bounded;');
  pgm.sql('ALTER TABLE invoice_line_items DROP CONSTRAINT IF EXISTS ili_amounts_sane;');
  pgm.dropColumns('invoice_line_items', [
    'discount_amount', 'tax_rate_bp', 'tax_amount',
    'plan_item_id', 'procedure_id', 'procedure_code_id', 'tooth', 'sort_order',
  ]);

  pgm.dropIndex('invoices', ['tenant_id', 'treatment_plan_id'], { ifExists: true });
  pgm.dropIndex('invoices', ['tenant_id', 'issued_at'], { ifExists: true });
  pgm.sql('ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoice_cancel_consistent;');
  pgm.sql('ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoice_currency_valid;');
  pgm.sql('ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoice_amounts_sane;');
  pgm.dropColumns('invoices', [
    'treatment_plan_id', 'subtotal', 'discount_amount', 'tax_amount',
    'currency', 'vat_rate_bp', 'due_on', 'notes', 'cancelled_at', 'cancel_reason',
  ]);

  pgm.dropColumns('procedure_codes', ['is_taxable']);
  pgm.dropColumns('treatments', ['is_taxable']);

  pgm.sql('ALTER TABLE clinic_settings DROP CONSTRAINT IF EXISTS cs_payment_terms_valid;');
  pgm.sql('ALTER TABLE clinic_settings DROP CONSTRAINT IF EXISTS cs_vat_rate_valid;');
  pgm.sql('ALTER TABLE clinic_settings DROP CONSTRAINT IF EXISTS cs_currency_valid;');
  pgm.dropColumns('clinic_settings', [
    'currency', 'vat_rate_bp', 'tax_number', 'payment_terms_days',
  ]);
};
