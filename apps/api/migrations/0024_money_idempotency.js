/**
 * 0024 — a repeated request cannot record money twice
 *
 * Payments have carried their Idempotency-Key since 0014, under a unique
 * index, so a retry that slips past the replay store fails instead of taking
 * the money twice. The replay store and the handler's transaction are two
 * commits, and a process that dies between them leaves a retry free to run
 * the handler again.
 *
 * The same guard now covers the other writes that create money: an invoice
 * (and with it the patient's ledger charge), an expense, and a ledger
 * adjustment. Invoicing a treatment plan needs nothing new: its lines point
 * at plan lines under a unique index already, so the same work cannot be
 * billed twice. Voiding locks the row and refuses a second void.
 *
 * The key is optional, as on payments: a row written without one is as
 * before. Its shape matches idempotency_keys (0013).
 */

exports.shorthands = undefined;

const TABLES = ['invoices', 'expenses', 'ledger_entries'];

const UP = TABLES.map(
  (t) => `
ALTER TABLE ${t}
  ADD COLUMN idempotency_key text,
  ADD CONSTRAINT ${t}_idempotency_key_shape CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$');
CREATE UNIQUE INDEX ${t}_idempotency_key_unique ON ${t} (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;`,
).join('\n');

const DOWN = TABLES.map(
  (t) => `
DROP INDEX IF EXISTS ${t}_idempotency_key_unique;
ALTER TABLE ${t}
  DROP CONSTRAINT IF EXISTS ${t}_idempotency_key_shape,
  DROP COLUMN IF EXISTS idempotency_key;`,
).join('\n');

exports.up = (pgm) => {
  pgm.sql(UP);
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
