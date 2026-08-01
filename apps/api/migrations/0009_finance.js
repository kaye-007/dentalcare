/**
 * 0009 — finance (tenant plane, M8): invoices, invoice_line_items, payments, expenses.
 * RLS pattern identical to previous tenant tables. Amounts are integers (Lekë).
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
  pgm.createTable('invoices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    seq: { type: 'integer', notNull: true },
    invoice_number: { type: 'text', notNull: true },
    status: {
      type: 'text', notNull: true, default: 'unpaid',
      check: "status IN ('unpaid','partially_paid','paid','cancelled')",
    },
    total: { type: 'integer', notNull: true, default: 0 },
    issued_at: { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql('CREATE UNIQUE INDEX invoices_tenant_seq_unique ON invoices (tenant_id, seq);');
  pgm.createIndex('invoices', ['tenant_id', 'status']);
  pgm.createIndex('invoices', ['tenant_id', 'patient_id']);
  RLS(pgm, 'invoices');

  pgm.createTable('invoice_line_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', notNull: true, references: 'invoices', onDelete: 'CASCADE' },
    treatment_id: { type: 'uuid', references: 'treatments', onDelete: 'SET NULL' },
    description: { type: 'text', notNull: true },
    quantity: { type: 'integer', notNull: true, default: 1 },
    unit_price: { type: 'integer', notNull: true, default: 0 },
    amount: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.sql('ALTER TABLE invoice_line_items ADD CONSTRAINT ili_qty_pos CHECK (quantity > 0);');
  pgm.createIndex('invoice_line_items', 'invoice_id');
  RLS(pgm, 'invoice_line_items');

  pgm.createTable('payments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', notNull: true, references: 'invoices', onDelete: 'CASCADE' },
    amount: { type: 'integer', notNull: true },
    method: { type: 'text', notNull: true, check: "method IN ('cash','card','bank')" },
    note: { type: 'text' },
    paid_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
  });
  pgm.sql('ALTER TABLE payments ADD CONSTRAINT pay_amount_pos CHECK (amount > 0);');
  pgm.createIndex('payments', ['tenant_id', 'paid_at']);
  pgm.createIndex('payments', 'invoice_id');
  RLS(pgm, 'payments');

  pgm.createTable('expenses', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    category: {
      type: 'text', notNull: true,
      check: "category IN ('rent','materials','utilities','salaries','lab','other')",
    },
    amount: { type: 'integer', notNull: true },
    expense_date: { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    note: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql('ALTER TABLE expenses ADD CONSTRAINT exp_amount_pos CHECK (amount > 0);');
  pgm.createIndex('expenses', ['tenant_id', 'expense_date']);
  RLS(pgm, 'expenses');
};

exports.down = (pgm) => {
  pgm.dropTable('expenses');
  pgm.dropTable('payments');
  pgm.dropTable('invoice_line_items');
  pgm.dropTable('invoices');
};
