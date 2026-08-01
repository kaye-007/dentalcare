/**
 * 0010 — reminders (tenant plane, M10)
 *
 *   clinic_settings  : + reminders_enabled, + reminder_hours_before
 *   reminders        : the reminder log/queue. Every reminder — automatic or
 *                      manual — is a row here, with the rendered message, the
 *                      channel used, and its delivery status. One automatic
 *                      reminder max per appointment (partial unique index).
 *
 * RLS pattern identical to all tenant tables.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('clinic_settings', {
    reminders_enabled: { type: 'boolean', notNull: true, default: false },
    reminder_hours_before: { type: 'integer', notNull: true, default: 24 },
  });
  pgm.sql(`ALTER TABLE clinic_settings ADD CONSTRAINT cs_reminder_hours_valid
             CHECK (reminder_hours_before BETWEEN 1 AND 168);`);

  pgm.createTable('reminders', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    appointment_id: { type: 'uuid', notNull: true, references: 'appointments', onDelete: 'CASCADE' },
    type: { type: 'text', notNull: true, check: "type IN ('automatic','manual')" },
    channel: { type: 'text', notNull: true, default: 'log' },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending','sent','failed')",
    },
    message: { type: 'text', notNull: true },
    error: { type: 'text' },
    sent_at: { type: 'timestamptz' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('reminders', ['tenant_id', 'created_at']);
  pgm.createIndex('reminders', 'appointment_id');
  // at most one automatic reminder per appointment — makes the scan idempotent
  pgm.sql(`CREATE UNIQUE INDEX reminders_auto_unique
             ON reminders (appointment_id) WHERE type = 'automatic';`);

  pgm.sql('ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE reminders FORCE ROW LEVEL SECURITY;');
  pgm.sql(`CREATE POLICY tenant_isolation ON reminders
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);
};

exports.down = (pgm) => {
  pgm.dropTable('reminders');
  pgm.sql('ALTER TABLE clinic_settings DROP CONSTRAINT IF EXISTS cs_reminder_hours_valid;');
  pgm.dropColumns('clinic_settings', ['reminders_enabled', 'reminder_hours_before']);
};
