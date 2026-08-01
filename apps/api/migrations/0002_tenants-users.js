/**
 * 0002 — tenants & users
 *
 * Minimal tenant + clinic-user tables to make authentication runnable.
 * Row-Level Security policies and subdomain resolution arrive in M3; for now
 * email is globally unique so login works without a tenant context.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('tenants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    subdomain: { type: 'text', notNull: true, unique: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'active',
      check: "status IN ('trial','active','suspended','cancelled')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'CASCADE',
    },
    email: { type: 'text', notNull: true },
    password_hash: { type: 'text', notNull: true },
    full_name: { type: 'text', notNull: true },
    role: {
      type: 'text',
      notNull: true,
      check: "role IN ('owner','reception')",
    },
    status: {
      type: 'text',
      notNull: true,
      default: 'active',
      check: "status IN ('active','disabled')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Case-insensitive global uniqueness on email (revisited per-tenant in M3).
  pgm.sql(
    'CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));',
  );
  pgm.createIndex('users', 'tenant_id');
};

exports.down = (pgm) => {
  pgm.dropTable('users');
  pgm.dropTable('tenants');
};
