/**
 * 0007 — treatments catalog & medical record (tenant plane, M7)
 *
 *   treatments     : the clinic's catalog (name, price in Lekë, duration,
 *                    single/multiple visit, active/inactive)
 *   tooth_records  : per-tooth medical record entries (FDI numbering),
 *                    optionally linked to a catalog treatment and a dentist
 *
 * RLS pattern identical to 0003/0005/0006.
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
  pgm.createTable('treatments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    price: { type: 'integer', notNull: true, default: 0 }, // Lekë, whole units
    duration_minutes: { type: 'integer', notNull: true, default: 60 },
    visit_type: {
      type: 'text',
      notNull: true,
      default: 'single',
      check: "visit_type IN ('single','multiple')",
    },
    status: {
      type: 'text',
      notNull: true,
      default: 'active',
      check: "status IN ('active','inactive')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('treatments', ['tenant_id', 'status']);
  pgm.sql('CREATE UNIQUE INDEX treatments_tenant_name_unique ON treatments (tenant_id, lower(name));');
  RLS(pgm, 'treatments');

  pgm.createTable('tooth_records', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    tooth: { type: 'smallint', notNull: true }, // FDI: 11–18, 21–28, 31–38, 41–48
    condition: { type: 'text', notNull: true },
    treatment_id: { type: 'uuid', references: 'treatments', onDelete: 'SET NULL' },
    dentist_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending','done')",
    },
    note: { type: 'text' },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
  });
  pgm.sql(`ALTER TABLE tooth_records ADD CONSTRAINT tooth_fdi_valid CHECK (
    (tooth BETWEEN 11 AND 18) OR (tooth BETWEEN 21 AND 28) OR
    (tooth BETWEEN 31 AND 38) OR (tooth BETWEEN 41 AND 48));`);
  pgm.createIndex('tooth_records', ['tenant_id', 'patient_id']);
  pgm.createIndex('tooth_records', ['tenant_id', 'patient_id', 'tooth']);
  RLS(pgm, 'tooth_records');
};

exports.down = (pgm) => {
  pgm.dropTable('tooth_records');
  pgm.dropTable('treatments');
};
