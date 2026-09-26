/**
 * 0015 — which document a payment issues
 *
 * Reception now chooses, as the money is taken, between two documents:
 *
 *   fiscal    faturë e fiskalizuar — registered with the tax authority, which
 *             returns the NIVF; the receipt carries the NSLF and the QR
 *   internal  faturë fiktive — an internal receipt that never reaches DPT,
 *             printed on the clinic's own letterhead and marked, in Albanian,
 *             as not a tax invoice
 *
 * ── Why the choice is stored ──────────────────────────────────────────────
 *
 * `fiscal_invoices` already answers "was this registered". It cannot answer
 * "what did the clinic mean to issue", and the two differ exactly when
 * something went wrong: a fiscal invoice whose registration was refused, or
 * one still waiting for the authority. Storing the intent beside the outcome
 * is what lets a screen say "fiscal invoice, not registered yet" rather than
 * quietly showing it as an internal receipt.
 *
 * It is also the evidence for a question an inspector may ask later: who
 * decided this sale would not be fiscalized. `document_chosen_by` names them;
 * the activity trail carries the same fact with the request and IP (0013).
 *
 * ── clinic_settings ───────────────────────────────────────────────────────
 *
 *   default_checkout_mode     what the payment screen preselects:
 *                             fiscal (the default), internal, or ask — no
 *                             preselection, so the choice is deliberate
 *   internal_receipts_enabled a clinic that fiscalizes everything turns the
 *                             internal receipt off, and the option disappears
 *
 * The default is `fiscal` on purpose: under Law 87/2019 a cash or card taking
 * is expected to be fiscalized when the money is taken, so the compliant path
 * is the one that needs no decision.
 */

exports.shorthands = undefined;

const UP = `
ALTER TABLE invoices
  ADD COLUMN document_kind text NOT NULL DEFAULT 'internal',
  ADD COLUMN document_chosen_by uuid,
  ADD COLUMN document_chosen_at timestamptz,
  ADD CONSTRAINT invoices_document_kind_known CHECK (document_kind IN ('internal', 'fiscal')),
  ADD CONSTRAINT invoices_document_choice_consistent CHECK (
    (document_chosen_by IS NULL) = (document_chosen_at IS NULL)),
  ADD CONSTRAINT invoices_document_chosen_by_fk FOREIGN KEY (document_chosen_by, tenant_id)
    REFERENCES users (id, tenant_id);

-- An invoice already registered with the authority is a fiscal invoice,
-- whoever chose it and whenever. FORCE binds the owner too.
ALTER TABLE invoices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE fiscal_invoices NO FORCE ROW LEVEL SECURITY;
UPDATE invoices i SET document_kind = 'fiscal'
  WHERE EXISTS (SELECT 1 FROM fiscal_invoices f WHERE f.invoice_id = i.id);
ALTER TABLE fiscal_invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

CREATE INDEX invoices_document_kind_idx ON invoices (tenant_id, document_kind, issued_at DESC);

ALTER TABLE clinic_settings
  ADD COLUMN default_checkout_mode text NOT NULL DEFAULT 'fiscal',
  ADD COLUMN internal_receipts_enabled boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT cs_checkout_mode_known CHECK (
    default_checkout_mode IN ('internal', 'fiscal', 'ask'));
`;

const DOWN = `
ALTER TABLE clinic_settings
  DROP CONSTRAINT IF EXISTS cs_checkout_mode_known,
  DROP COLUMN IF EXISTS internal_receipts_enabled,
  DROP COLUMN IF EXISTS default_checkout_mode;

DROP INDEX IF EXISTS invoices_document_kind_idx;

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_document_chosen_by_fk,
  DROP CONSTRAINT IF EXISTS invoices_document_choice_consistent,
  DROP CONSTRAINT IF EXISTS invoices_document_kind_known,
  DROP COLUMN IF EXISTS document_chosen_at,
  DROP COLUMN IF EXISTS document_chosen_by,
  DROP COLUMN IF EXISTS document_kind;
`;

exports.up = (pgm) => {
  pgm.sql(UP);
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
