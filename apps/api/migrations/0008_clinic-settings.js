/**
 * 0008 — clinic settings (tenant plane, correction pass)
 *
 * One row per tenant: contact profile, working hours (jsonb, 7 entries),
 * and basic preferences. Clinic display name stays on tenants.name and is
 * editable through the settings endpoint (RLS already scopes tenants).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('clinic_settings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, unique: true, references: 'tenants', onDelete: 'CASCADE' },
    address: { type: 'text' },
    city: { type: 'text' },
    phone: { type: 'text' },
    email: { type: 'text' },
    working_hours: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(`'[]'::jsonb`),
    },
    default_appointment_duration: { type: 'integer', notNull: true, default: 45 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.sql('ALTER TABLE clinic_settings ENABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE clinic_settings FORCE ROW LEVEL SECURITY;');
  pgm.sql(`CREATE POLICY tenant_isolation ON clinic_settings
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);
};

exports.down = (pgm) => {
  pgm.dropTable('clinic_settings');
};
