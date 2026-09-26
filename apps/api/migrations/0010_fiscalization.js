/**
 * 0010 — Albanian fiscalization (fiskalizimi)
 *
 * An invoice registered with the tax authority's Central Information System
 * (CIS) carries two codes that make it a fiscal document: the NSLF (Issuer
 * Security Code, "IIC" in the schema), which the clinic computes by signing
 * the invoice with its own certificate, and the NIVF (Fiscal Identification
 * Code, "FIC"), which CIS returns. Both are printed, with a QR code that lets
 * the patient verify the invoice on the authority's portal.
 *
 * ── clinic_fiscal_settings ────────────────────────────────────────────────
 *
 * One row per clinic. The business unit and cash register (TCR) codes are
 * issued when the clinic registers them with the authority. The signing
 * certificate's private key is sealed with the same envelope as MFA secrets
 * (AES-256-GCM under MFA_ENCRYPTION_KEYS, bound to the clinic), so a database
 * read alone does not yield the key that signs the clinic's invoices.
 *
 * ── fiscal_counters ───────────────────────────────────────────────────────
 *
 * InvOrdNum is sequential per cash register per calendar year, with no gaps.
 * A counter row locked FOR UPDATE, not max()+1, because two receptionists
 * registering at the same moment must not both take 41.
 *
 * ── fiscal_invoices ───────────────────────────────────────────────────────
 *
 *   pending     signed and numbered, not yet acknowledged by CIS. The NSLF
 *               and the QR are already valid; the law allows delivery within
 *               48 hours when the connection is down, and the scheduler
 *               retries as a subsequent delivery.
 *   fiscalized  CIS returned the NIVF.
 *   rejected    CIS refused it with a fault. Needs a person.
 *
 * What was signed — the order number, the issue time string, the codes, the
 * NSLF and its signature — can never change: the runtime role may UPDATE only
 * the delivery columns. There is no DELETE.
 *
 * ── the invoice it belongs to ─────────────────────────────────────────────
 *
 * Triggers refuse to cancel an invoice, or void a payment on it, once it has
 * been registered. A fiscal invoice is corrected by a corrective invoice, not
 * by making the original disappear locally while it still exists at CIS.
 *
 * ── fiscal_cash_deposits ──────────────────────────────────────────────────
 *
 * CIS expects the opening cash in a register to be declared before the day's
 * cash invoices. The record of each declaration and CIS's answer.
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

/** Business unit, cash register and operator codes: "ab123ab123". */
const CODE = `'^[a-z]{2}[0-9]{3}[a-z]{2}[0-9]{3}$'`;

const UP = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_id_tenant_key') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_id_tenant_key UNIQUE (id, tenant_id);
  END IF;
END $$;

-- ── settings ─────────────────────────────────────────────────────────────
CREATE TABLE clinic_fiscal_settings (
  tenant_id               uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled                 boolean NOT NULL DEFAULT false,
  environment             text NOT NULL DEFAULT 'test',
  business_unit_code      text,
  tcr_code                text,
  is_issuer_in_vat        boolean NOT NULL DEFAULT false,
  vat_exemption_code      text NOT NULL DEFAULT 'TYPE_1',
  certificate_pem         text,
  certificate_subject     text,
  certificate_not_after   timestamptz,
  private_key_ciphertext  text,
  private_key_key_id      text,
  updated_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cfs_environment_known CHECK (environment IN ('test','production')),
  CONSTRAINT cfs_bu_code CHECK (business_unit_code IS NULL OR business_unit_code ~ ${CODE}),
  CONSTRAINT cfs_tcr_code CHECK (tcr_code IS NULL OR tcr_code ~ ${CODE}),
  CONSTRAINT cfs_exemption_known CHECK (vat_exemption_code ~ '^TYPE_[0-9]{1,2}$'),
  CONSTRAINT cfs_key_consistent CHECK (
    (private_key_ciphertext IS NULL) = (private_key_key_id IS NULL)
    AND (private_key_ciphertext IS NULL) = (certificate_pem IS NULL)),
  CONSTRAINT cfs_enabled_complete CHECK (
    NOT enabled OR (business_unit_code IS NOT NULL AND tcr_code IS NOT NULL
                    AND private_key_ciphertext IS NOT NULL))
);

ALTER TABLE clinic_fiscal_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_fiscal_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clinic_fiscal_settings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON TABLE clinic_fiscal_settings TO __APP_USER__;

-- Who is operating the register when an invoice is issued.
ALTER TABLE users
  ADD COLUMN fiscal_operator_code text,
  ADD CONSTRAINT users_fiscal_operator_code CHECK (
    fiscal_operator_code IS NULL OR fiscal_operator_code ~ ${CODE});

-- ── counters ─────────────────────────────────────────────────────────────
CREATE TABLE fiscal_counters (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tcr_code     text NOT NULL,
  year         integer NOT NULL,
  last_number  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, tcr_code, year),
  CONSTRAINT fiscal_counters_positive CHECK (last_number >= 0),
  CONSTRAINT fiscal_counters_year_sane CHECK (year BETWEEN 2020 AND 2200)
);

ALTER TABLE fiscal_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_counters FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_counters
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
GRANT SELECT, INSERT ON TABLE fiscal_counters TO __APP_USER__;
GRANT UPDATE (last_number) ON TABLE fiscal_counters TO __APP_USER__;

-- ── registered invoices ──────────────────────────────────────────────────
CREATE TABLE fiscal_invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id          uuid NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  environment         text NOT NULL,
  type_of_invoice     text NOT NULL,
  business_unit_code  text NOT NULL,
  tcr_code            text NOT NULL,
  operator_code       text NOT NULL,
  software_code       text NOT NULL,
  inv_ord_num         integer NOT NULL,
  inv_num             text NOT NULL,
  issue_datetime      text NOT NULL,
  total_price         integer NOT NULL,
  iic                 text NOT NULL,
  iic_signature       text NOT NULL,
  fic                 text,
  qr_url              text NOT NULL,
  payload             jsonb NOT NULL,
  attempts            integer NOT NULL DEFAULT 0,
  last_attempt_at     timestamptz,
  next_attempt_at     timestamptz,
  fiscalized_at       timestamptz,
  last_error          text,
  last_error_code     text,
  last_request_xml    text,
  last_response_xml   text,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_invoices_invoice_fk FOREIGN KEY (invoice_id, tenant_id)
    REFERENCES invoices (id, tenant_id),
  CONSTRAINT fiscal_invoices_one_per_invoice UNIQUE (invoice_id),
  CONSTRAINT fiscal_invoices_number_unique UNIQUE (tenant_id, tcr_code, inv_num),
  CONSTRAINT fiscal_invoices_status_known CHECK (status IN ('pending','fiscalized','rejected')),
  CONSTRAINT fiscal_invoices_env_known CHECK (environment IN ('test','production')),
  CONSTRAINT fiscal_invoices_type_known CHECK (type_of_invoice IN ('CASH','NONCASH')),
  CONSTRAINT fiscal_invoices_fic_consistent CHECK ((status = 'fiscalized') = (fic IS NOT NULL)),
  CONSTRAINT fiscal_invoices_iic_format CHECK (iic ~ '^[0-9A-F]{32}$'),
  CONSTRAINT fiscal_invoices_ord_positive CHECK (inv_ord_num > 0),
  CONSTRAINT fiscal_invoices_attempts_sane CHECK (attempts BETWEEN 0 AND 1000)
);

CREATE INDEX fiscal_invoices_due_idx
  ON fiscal_invoices (tenant_id, next_attempt_at) WHERE status = 'pending';

ALTER TABLE fiscal_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_invoices FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_invoices
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
GRANT SELECT, INSERT ON TABLE fiscal_invoices TO __APP_USER__;
GRANT UPDATE (status, fic, attempts, last_attempt_at, next_attempt_at, fiscalized_at,
              last_error, last_error_code, last_request_xml, last_response_xml, updated_at)
  ON TABLE fiscal_invoices TO __APP_USER__;

-- ── cash declarations ────────────────────────────────────────────────────
CREATE TABLE fiscal_cash_deposits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tcr_code         text NOT NULL,
  operation        text NOT NULL,
  amount           integer NOT NULL,
  change_datetime  text NOT NULL,
  status           text NOT NULL,
  fcdc             text,
  last_error       text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_cash_operation_known CHECK (operation IN ('INITIAL','WITHDRAW')),
  CONSTRAINT fiscal_cash_amount_sane CHECK (amount >= 0),
  CONSTRAINT fiscal_cash_status_known CHECK (status IN ('registered','rejected','unreachable')),
  CONSTRAINT fiscal_cash_fcdc_consistent CHECK ((status = 'registered') = (fcdc IS NOT NULL))
);

ALTER TABLE fiscal_cash_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_cash_deposits FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_cash_deposits
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
GRANT SELECT, INSERT ON TABLE fiscal_cash_deposits TO __APP_USER__;

-- ── a registered invoice is corrected, never cancelled locally ───────────
CREATE FUNCTION invoice_fiscal_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
     AND EXISTS (SELECT 1 FROM fiscal_invoices WHERE invoice_id = NEW.id) THEN
    RAISE EXCEPTION 'This invoice is registered with the tax authority and cannot be cancelled. Issue a corrective invoice instead.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invoices_fiscal_lock
  BEFORE UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoice_fiscal_lock();

CREATE FUNCTION payment_fiscal_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL
     AND EXISTS (SELECT 1 FROM fiscal_invoices WHERE invoice_id = NEW.invoice_id) THEN
    RAISE EXCEPTION 'This payment belongs to an invoice registered with the tax authority. Issue a corrective invoice instead of voiding it.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payments_fiscal_lock
  BEFORE UPDATE OF voided_at ON payments
  FOR EACH ROW EXECUTE FUNCTION payment_fiscal_lock();
`;

const DOWN = `
ALTER TABLE fiscal_invoices NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM fiscal_invoices WHERE environment = 'production') THEN
    RAISE EXCEPTION 'Invoices are registered with the tax authority; rolling back 0010 would lose their NSLF and NIVF.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS payments_fiscal_lock ON payments;
DROP FUNCTION IF EXISTS payment_fiscal_lock();
DROP TRIGGER IF EXISTS invoices_fiscal_lock ON invoices;
DROP FUNCTION IF EXISTS invoice_fiscal_lock();

DROP TABLE IF EXISTS fiscal_cash_deposits;
DROP TABLE IF EXISTS fiscal_invoices;
DROP TABLE IF EXISTS fiscal_counters;
DROP TABLE IF EXISTS clinic_fiscal_settings;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_fiscal_operator_code,
  DROP COLUMN IF EXISTS fiscal_operator_code;
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
