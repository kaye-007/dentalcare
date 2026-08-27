/**
 * 0017 — two access roles: `admin` (the doctor) and `receptionist`
 *
 * Supersedes 0012's admin|dentist|receptionist model. The product decision is
 * that a clinic runs on exactly two accounts: the doctor, who is also the
 * administrator, and the front desk.
 *
 * ── This migration ESCALATES privilege, deliberately ──────────────────────
 *
 * 0012 was authority-preserving by design. This one is not, and cannot be:
 * `dentist` is being removed, and the only remaining role that keeps clinical
 * write access is `admin`. Every existing dentist therefore gains payroll,
 * reports, staff management and settings.
 *
 * That is correct under the new model — the dentist IS the doctor IS the
 * administrator — but it must never happen silently on a table of medical
 * records. So before the UPDATE runs, the exact set of users about to be
 * escalated is written to `audit_log` as a permanent record. That row is also
 * what makes `down()` exact rather than lossy: it can put back precisely the
 * accounts this migration promoted, and nobody else.
 *
 * If a clinic has an associate dentist who should NOT be an administrator,
 * there is no longer a role for them. Demote them to `receptionist` (which
 * now carries clinical:write) BEFORE running this, or accept the promotion.
 *
 * Stored values stay `admin` / `receptionist`. The UI labels them Doctor and
 * Reception; `users.position` remains the free-text job title and still
 * grants nothing.
 */

exports.shorthands = undefined;

const THREE_ROLE_CHECK = "role IN ('admin','dentist','receptionist')";
const TWO_ROLE_CHECK = "role IN ('admin','receptionist')";

exports.up = (pgm) => {
  /* 1. Record the escalation before the evidence is overwritten. ---------- */
  pgm.sql(`
    INSERT INTO audit_log (actor_type, actor_label, action, entity_type, metadata)
    SELECT 'migration',
           '0017_two-role-model',
           'role.collapsed',
           'users',
           jsonb_build_object(
             'from',     'dentist',
             'to',       'admin',
             'count',    count(*),
             'user_ids', jsonb_agg(u.id ORDER BY u.id)
           )
      FROM users u
     WHERE u.role = 'dentist'
    HAVING count(*) > 0;
  `);

  /* 2. Collapse. The CHECK must go first — it forbids nothing new here, but
        0012's version would reject a later re-run against stale data.  ----- */
  pgm.sql('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;');

  pgm.sql(`UPDATE users SET role = 'admin' WHERE role = 'dentist';`);

  // Defensive: pre-0012 spellings should already be gone, but a database
  // restored from an old dump would still carry them and must not be left
  // holding a value the new CHECK rejects.
  pgm.sql(`UPDATE users SET role = 'admin'        WHERE role = 'owner';`);
  pgm.sql(`UPDATE users SET role = 'receptionist' WHERE role IN ('frontdesk', 'reception');`);

  pgm.sql(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (${TWO_ROLE_CHECK});`);

  /* 3. Same safety rail as 0012: no clinic may be left without an admin. -- */
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
          'Migration 0017 aborted: these clinics would have no active admin: %',
          orphaned;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;');
  pgm.sql(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (${THREE_ROLE_CHECK});`);

  // Demote exactly the accounts this migration promoted, from the record it
  // left behind — not "every admin", which would strip real administrators.
  pgm.sql(`
    UPDATE users u
       SET role = 'dentist'
     WHERE u.role = 'admin'
       AND EXISTS (
             SELECT 1
               FROM audit_log a
               CROSS JOIN LATERAL jsonb_array_elements_text(a.metadata->'user_ids') AS x(uid)
              WHERE a.actor_type = 'migration'
                AND a.action     = 'role.collapsed'
                AND a.metadata->>'from' = 'dentist'
                AND x.uid::uuid = u.id
           );
  `);
};
