/**
 * 0001 — init extensions
 *
 * Enables pgcrypto so future migrations can default UUID primary keys with
 * gen_random_uuid(). This first migration also proves the migration pipeline
 * end-to-end before any business tables are introduced.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropExtension('pgcrypto', { ifNotExists: true });
};
