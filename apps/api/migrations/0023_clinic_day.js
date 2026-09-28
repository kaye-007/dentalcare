/**
 * 0023 — "today" is the clinic's today
 *
 * Seven date columns defaulted to CURRENT_DATE, and fourteen queries used it
 * for "today". CURRENT_DATE is the date on the database server's clock,
 * which for a hosted database is UTC. Between midnight and 01:00 or 02:00 in
 * Tirana that is still yesterday. An invoice written at 00:30 was dated the
 * day before, while its fiscal registration, dated on Tirana's clock, was
 * not; on 1 January the two even fell in different years.
 *
 * Reports already counted days on the clinic's clock, each with its own copy
 * of the expression. This gives the database one definition:
 *
 *   clinic_zone_of(tenant)   that clinic's time zone (clinic_settings),
 *                            Europe/Tirane when it has none
 *   clinic_zone()            the zone of the clinic this transaction is for,
 *                            app.current_tenant_id, which withTenant() sets
 *   clinic_today()           the date on that clinic's clock
 *
 * and makes clinic_today() the default of every date column that meant
 * "today". The application's queries use the same functions.
 *
 * Invoker's rights, like clinic_currency_of (0006): under app_user the
 * settings row is read through row-level security, so a clinic can only ever
 * see its own zone. Outside any clinic's transaction the zone is Tirana's.
 */

exports.shorthands = undefined;

/** [table, column] — every date column whose default was CURRENT_DATE. */
const DEFAULTED = [
  ['invoices', 'issued_at'],
  ['ledger_entries', 'occurred_on'],
  ['expenses', 'expense_date'],
  ['clinical_procedures', 'performed_on'],
  ['perio_exams', 'examined_on'],
  ['salary_payments', 'paid_on'],
  ['inventory_lots', 'received_on'],
];

const UP = `
CREATE FUNCTION clinic_zone_of(p_tenant uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT timezone FROM clinic_settings WHERE tenant_id = p_tenant),
    'Europe/Tirane')
$$;

CREATE FUNCTION clinic_zone() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT clinic_zone_of(nullif(current_setting('app.current_tenant_id', true), '')::uuid)
$$;

CREATE FUNCTION clinic_today() RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE clinic_zone())::date
$$;

${DEFAULTED.map(([t, c]) => `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT clinic_today();`).join('\n')}
`;

const DOWN = `
${DEFAULTED.map(([t, c]) => `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT CURRENT_DATE;`).join('\n')}

DROP FUNCTION clinic_today();
DROP FUNCTION clinic_zone();
DROP FUNCTION clinic_zone_of(uuid);
`;

exports.up = (pgm) => {
  pgm.sql(UP);
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
