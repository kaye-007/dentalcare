/**
 * 0012 — three access roles
 *
 * Replaces the binary owner|frontdesk model with admin|dentist|receptionist.
 *
 * Mapping is deliberately AUTHORITY-PRESERVING, not inferred:
 *
 *     owner      -> admin          (same authority)
 *     frontdesk  -> receptionist   (same authority)
 *
 * Nobody is promoted to `dentist` automatically, even where `position` reads
 * 'Dentist'. `position` is a job title with no permission meaning, and a
 * migration that grants clinical write access based on a free-text field
 * would be silently escalating privilege on a table of medical records. New
 * dentists are appointed deliberately by an admin through Staff.
 *
 * Safety rail: every tenant must retain at least one admin, or a clinic could
 * be left with nobody able to manage staff or settings. The migration asserts
 * this and aborts the transaction rather than leaving a clinic locked out.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Drop first: the existing CHECK forbids the new values.
  pgm.sql('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;');

  pgm.sql(`UPDATE users SET role = 'admin'        WHERE role = 'owner';`);
  pgm.sql(`UPDATE users SET role = 'receptionist' WHERE role IN ('frontdesk', 'reception');`);

  pgm.sql(`
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin','dentist','receptionist'));
  `);

  // Refuse to leave any clinic without an administrator.
  pgm.sql(`
    DO $$
    DECLARE
      orphaned text;
    BEGIN
      SELECT string_agg(t.subdomain, ', ' ORDER BY t.subdomain)
        INTO orphaned
        FROM tenants t
       WHERE EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id)
         AND NOT EXISTS (
               SELECT 1 FROM users u
                WHERE u.tenant_id = t.id
                  AND u.role = 'admin'
                  AND u.status = 'active'
             );

      IF orphaned IS NOT NULL THEN
        RAISE EXCEPTION
          'Migration 0012 aborted: these clinics would have no active admin: %',
          orphaned;
      END IF;
    END $$;
  `);

  pgm.createIndex('users', ['tenant_id', 'role'], {
    name: 'users_tenant_role_idx',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('users', ['tenant_id', 'role'], {
    name: 'users_tenant_role_idx',
    ifExists: true,
  });

  pgm.sql('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;');

  // Reverse mapping. `dentist` has no pre-0012 equivalent; it collapses to
  // frontdesk, which REMOVES authority rather than granting it. Rolling back
  // therefore loses the dentist/receptionist distinction — expected, and the
  // safe direction to lose it in.
  pgm.sql(`UPDATE users SET role = 'owner'     WHERE role = 'admin';`);
  pgm.sql(`UPDATE users SET role = 'frontdesk' WHERE role IN ('dentist', 'receptionist');`);

  pgm.sql(`
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('owner','frontdesk'));
  `);
};
