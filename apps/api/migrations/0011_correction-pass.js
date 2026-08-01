/**
 * 0011 — focused correction pass
 *
 *   users           : platform access roles are exactly Owner and Frontdesk.
 *                     Existing 'reception' rows are migrated to 'frontdesk'.
 *                     + position (descriptive job title, NOT a permission),
 *                     + salary_amount, + salary_note (payroll tracking).
 *   salary_payments : lightweight salary payment log (owner-only feature).
 *   treatments      : visit_type becomes optional (single / multiple / NULL).
 *   clinic_settings : + payroll_logging_enabled (owner-controlled config for
 *                     the salary payment logging flow).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ── platform roles: owner | frontdesk only ──
  pgm.sql('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;');
  pgm.sql(`UPDATE users SET role = 'frontdesk' WHERE role = 'reception';`);
  pgm.sql(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','frontdesk'));`);

  // ── staff payroll fields (descriptive position + salary tracking) ──
  pgm.addColumns('users', {
    position: { type: 'text' },
    salary_amount: { type: 'integer' },
    salary_note: { type: 'text' },
  });
  pgm.sql(`ALTER TABLE users ADD CONSTRAINT users_salary_positive
             CHECK (salary_amount IS NULL OR salary_amount > 0);`);

  // ── salary payment log ──
  pgm.createTable('salary_payments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    staff_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    position: { type: 'text' }, // snapshot at payment time
    amount: { type: 'integer', notNull: true },
    paid_on: { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    note: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql('ALTER TABLE salary_payments ADD CONSTRAINT sp_amount_pos CHECK (amount > 0);');
  pgm.createIndex('salary_payments', ['tenant_id', 'paid_on']);
  pgm.sql('ALTER TABLE salary_payments ENABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE salary_payments FORCE ROW LEVEL SECURITY;');
  pgm.sql(`CREATE POLICY tenant_isolation ON salary_payments
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);

  // ── treatments: visit type optional ──
  pgm.sql('ALTER TABLE treatments ALTER COLUMN visit_type DROP NOT NULL;');
  pgm.sql('ALTER TABLE treatments ALTER COLUMN visit_type DROP DEFAULT;');
  // existing CHECK (visit_type IN ('single','multiple')) passes NULL — kept as is

  // ── payroll logging config ──
  pgm.addColumns('clinic_settings', {
    payroll_logging_enabled: { type: 'boolean', notNull: true, default: true },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('clinic_settings', ['payroll_logging_enabled']);
  pgm.sql(`UPDATE treatments SET visit_type = 'single' WHERE visit_type IS NULL;`);
  pgm.sql(`ALTER TABLE treatments ALTER COLUMN visit_type SET DEFAULT 'single';`);
  pgm.sql('ALTER TABLE treatments ALTER COLUMN visit_type SET NOT NULL;');
  pgm.dropTable('salary_payments');
  pgm.sql('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_salary_positive;');
  pgm.dropColumns('users', ['position', 'salary_amount', 'salary_note']);
  pgm.sql('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;');
  pgm.sql(`UPDATE users SET role = 'reception' WHERE role = 'frontdesk';`);
  pgm.sql(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','reception'));`);
};
