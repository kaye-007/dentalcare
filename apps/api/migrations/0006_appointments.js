/**
 * 0006 — appointments (tenant plane, M6)
 *
 * Appointment references a patient and optionally a staff member (practitioner).
 * `reason` is free text for now — the treatments catalog arrives in M7 and will
 * link here then. RLS pattern identical to 0003/0005.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('appointments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    staff_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    reason: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'scheduled',
      check: "status IN ('scheduled','completed','cancelled','no_show')",
    },
    starts_at: { type: 'timestamptz', notNull: true },
    ends_at: { type: 'timestamptz', notNull: true },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql('ALTER TABLE appointments ADD CONSTRAINT appt_time_valid CHECK (ends_at > starts_at);');
  pgm.createIndex('appointments', ['tenant_id', 'starts_at']);
  pgm.createIndex('appointments', ['tenant_id', 'patient_id']);
  pgm.createIndex('appointments', ['tenant_id', 'staff_id']);

  pgm.sql('ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE appointments FORCE ROW LEVEL SECURITY;');
  pgm.sql(`CREATE POLICY tenant_isolation ON appointments
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);
};

exports.down = (pgm) => {
  pgm.dropTable('appointments');
};
