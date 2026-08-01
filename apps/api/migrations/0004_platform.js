/**
 * 0004 — platform plane (superadmin tenant management)
 *
 *   - plans            : subscription tiers selectable on tenant creation
 *   - platform_admins  : NODE X superadmin identities (separate from clinic users)
 *   - audit_log        : append-only record of platform actions
 *   - tenants          : + plan_id, trial_ends_at; status -> active/suspended/archived
 *
 * Platform tables are accessed only via the privileged admin connection, so
 * they carry no RLS. app_user is explicitly revoked from the sensitive ones.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  const appUser = process.env.APP_DB_USER || 'app_user';

  pgm.createTable('plans', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    code: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    price_monthly: { type: 'integer', notNull: true, default: 0 },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('platform_admins', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'text', notNull: true },
    password_hash: { type: 'text', notNull: true },
    full_name: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'active',
      check: "status IN ('active','disabled')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(
    'CREATE UNIQUE INDEX platform_admins_email_lower_unique ON platform_admins (lower(email));',
  );

  pgm.createTable('audit_log', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    actor_type: { type: 'text', notNull: true },
    actor_id: { type: 'uuid' },
    actor_label: { type: 'text' },
    action: { type: 'text', notNull: true },
    entity_type: { type: 'text', notNull: true },
    entity_id: { type: 'uuid' },
    metadata: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('audit_log', ['entity_type', 'entity_id']);
  pgm.createIndex('audit_log', 'created_at');

  // tenants: plan + trial, and the M4 status set
  pgm.addColumns('tenants', {
    plan_id: { type: 'uuid', references: 'plans', onDelete: 'SET NULL' },
    trial_ends_at: { type: 'timestamptz' },
  });
  pgm.sql('ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;');
  pgm.sql(
    "ALTER TABLE tenants ADD CONSTRAINT tenants_status_check CHECK (status IN ('active','suspended','archived'));",
  );

  // app_user (clinic plane) must not see platform identities or the audit log.
  pgm.sql(`REVOKE ALL ON platform_admins FROM ${appUser};`);
  pgm.sql(`REVOKE ALL ON audit_log FROM ${appUser};`);
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;');
  pgm.sql(
    "ALTER TABLE tenants ADD CONSTRAINT tenants_status_check CHECK (status IN ('trial','active','suspended','cancelled'));",
  );
  pgm.dropColumns('tenants', ['plan_id', 'trial_ends_at']);
  pgm.dropTable('audit_log');
  pgm.dropTable('platform_admins');
  pgm.dropTable('plans');
};
