/**
 * 0005 — patients & patient notes (tenant plane)
 *
 * Both tables are tenant-scoped with FORCE ROW LEVEL SECURITY, identical to
 * the pattern established in 0003. app_user receives DML automatically via the
 * default privileges set in 0003; RLS policies are added explicitly here.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('patients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    first_name: { type: 'text', notNull: true },
    last_name: { type: 'text', notNull: true },
    phone: { type: 'text' },
    email: { type: 'text' },
    gender: { type: 'text', check: "gender IN ('male','female','other')" },
    birth_date: { type: 'date' },
    address: { type: 'text' },
    city: { type: 'text' },
    postal_code: { type: 'text' },
    status: {
      type: 'text',
      notNull: true,
      default: 'active',
      check: "status IN ('active','inactive')",
    },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('patients', 'tenant_id');
  pgm.createIndex('patients', ['tenant_id', 'status']);

  pgm.sql('ALTER TABLE patients ENABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE patients FORCE ROW LEVEL SECURITY;');
  pgm.sql(`CREATE POLICY tenant_isolation ON patients
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);

  pgm.createTable('patient_notes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    body: { type: 'text', notNull: true },
    author_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('patient_notes', 'tenant_id');
  pgm.createIndex('patient_notes', 'patient_id');

  pgm.sql('ALTER TABLE patient_notes ENABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE patient_notes FORCE ROW LEVEL SECURITY;');
  pgm.sql(`CREATE POLICY tenant_isolation ON patient_notes
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);
};

exports.down = (pgm) => {
  pgm.dropTable('patient_notes');
  pgm.dropTable('patients');
};
