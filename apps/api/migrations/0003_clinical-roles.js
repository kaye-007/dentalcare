/**
 * 0003 — clinical roles
 *
 * Widens users.role from the two-role model (0017: admin | receptionist) to
 * five: admin, dentist, hygienist, assistant, receptionist.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 *
 * The two-role model fitted one dentist who was also the administrator. A
 * second dentist had to be made an administrator — salaries, the audit trail,
 * every staff account — or reception, which charts but can be accountable for
 * nothing. Neither is true of an associate. What each role may do is decided
 * in packages/shared/src/permissions.ts; this migration only lets the rows
 * hold the new values.
 *
 * No existing row changes. Every current admin stays admin, every receptionist
 * stays receptionist; moving a dentist off admin is a deliberate act in Staff.
 *
 * ── Rolling back ──────────────────────────────────────────────────────────
 *
 * Reversible while nobody holds a new role. Once someone does, re-adding the
 * narrower constraint fails on that row — which is the right outcome: silently
 * promoting a dentist to admin, or demoting them to reception, is a decision a
 * migration must not make on anyone's behalf.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin', 'dentist', 'hygienist', 'assistant', 'receptionist'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin', 'receptionist'));
  `);
};
