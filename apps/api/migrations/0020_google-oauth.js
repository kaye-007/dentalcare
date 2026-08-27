/**
 * 0020 — Google sign-in
 *
 * Columns to link an existing account to a Google identity. Sign-in never
 * CREATES an account: a clinic user exists because an administrator created
 * them, and a platform administrator exists because someone inserted the row
 * by hand. Google only proves who is at the keyboard.
 *
 * ── Why the subject id is stored, and not just the email ──────────────────
 *
 * Matching on email alone is the standard way this feature goes wrong. Email
 * addresses are reassigned — a clinic recycles `info@` when the receptionist
 * leaves — and a Google account can change its address. If the only join key
 * is the email, whoever holds that address next inherits the old account's
 * patients.
 *
 * So the FIRST successful Google sign-in records `sub`, Google's immutable
 * subject id, and every later sign-in must match it. A verified email that
 * arrives with a different `sub` is refused, not linked. That turns a silent
 * account takeover into a support call.
 *
 * The uniqueness is per clinic, not global: the same dentist can legitimately
 * work at two practices on the platform, and each is a separate account.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  for (const table of ['users', 'platform_admins']) {
    pgm.addColumns(table, {
      /** Google's `sub` claim — immutable for the life of the account. */
      google_sub: { type: 'text' },
      /** When the link was established. Null means password-only. */
      google_linked_at: { type: 'timestamptz' },
    });

    // A link is a subject and a time. Half a link is not a state worth having.
    pgm.sql(`
      ALTER TABLE ${table} ADD CONSTRAINT ${table}_google_link_consistent
        CHECK ((google_sub IS NULL) = (google_linked_at IS NULL));
    `);
  }

  // One Google identity per clinic. Partial, so the many rows with no link
  // do not collide with each other on NULL.
  pgm.sql(`
    CREATE UNIQUE INDEX users_tenant_google_sub_unique
      ON users (tenant_id, google_sub)
      WHERE google_sub IS NOT NULL;
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX platform_admins_google_sub_unique
      ON platform_admins (google_sub)
      WHERE google_sub IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS platform_admins_google_sub_unique;');
  pgm.sql('DROP INDEX IF EXISTS users_tenant_google_sub_unique;');
  for (const table of ['users', 'platform_admins']) {
    pgm.sql(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_google_link_consistent;`);
    pgm.dropColumns(table, ['google_sub', 'google_linked_at']);
  }
};
