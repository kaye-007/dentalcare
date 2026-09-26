/**
 * 0014 — the cash drawer: sessions, events, counts, reviews, approvals
 *
 * A receptionist opens a drawer with a float, every cash payment she takes
 * lands in her session, and at the end of the shift she counts what is there.
 * The expected amount is derived from the session's events, never typed; the
 * difference is explained, and a large one is approved by someone else.
 *
 * ── Evidence, not state ───────────────────────────────────────────────────
 *
 *   drawer_events            every movement of cash, in order. Append-only,
 *                            numbered without gaps per session, and chained:
 *                            each row carries the SHA-256 of the one before,
 *                            so a row removed by someone with the owner's
 *                            password still shows as a broken chain.
 *   drawer_counts            every count, including the ones that were
 *                            recounted. Append-only.
 *   drawer_session_reviews   what was expected, counted and explained per
 *                            currency at close. Append-only.
 *   manager_approvals        who approved what, how, and why. Append-only.
 *
 * `drawer_sessions` is the only row that changes, and only forward: open →
 * counting → pending_approval → closed, or to force_closed from any unclosed
 * state. A trigger refuses anything else, including reopening.
 *
 * ── One person, one drawer ────────────────────────────────────────────────
 *
 * At most one unclosed session per drawer, and per person. A receptionist
 * holding two drawers can move a shortage between them; two receptionists in
 * one session cannot be told apart when the count is short.
 *
 * ── payments.drawer_session_id, payments.idempotency_key ──────────────────
 *
 * A cash payment names the session it went into. The key is the second guard
 * behind the idempotency interceptor (0013): a repeated request that got past
 * it fails here, on the unique index, instead of taking the money twice.
 *
 * ── users.approval_pin_hash ───────────────────────────────────────────────
 *
 * A manager approving a variance at the receptionist's desk types a personal
 * PIN — theirs, never a shared one, so the approval names a person. bcrypt,
 * like the password, locked for 15 minutes after five wrong tries.
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

const CURRENCIES = `('EUR','ALL','USD','GBP','CHF')`;
const OPEN_STATES = `('open','counting','pending_approval')`;
/** Cash register codes as CIS issues them: "ab123ab123". Matches 0010. */
const TCR_CODE = `'^[a-z]{2}[0-9]{3}[a-z]{2}[0-9]{3}$'`;
const HASH = `'^[0-9a-f]{64}$'`;

const rls = (table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${table}
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`;

const appendOnly = (table) => `
CREATE TRIGGER ${table}_no_rewrite
  BEFORE UPDATE OR DELETE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER ${table}_no_truncate
  BEFORE TRUNCATE ON ${table}
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
GRANT SELECT, INSERT ON TABLE ${table} TO __APP_USER__;`;

const UP = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_id_tenant_key') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_id_tenant_key UNIQUE (id, tenant_id);
  END IF;
END $$;

-- ── policy ───────────────────────────────────────────────────────────────
CREATE TABLE drawer_policies (
  tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  blind_count    boolean NOT NULL DEFAULT true,
  max_recounts   smallint NOT NULL DEFAULT 1,
  thresholds     jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_float  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drawer_policies_recounts CHECK (max_recounts BETWEEN 0 AND 3),
  CONSTRAINT drawer_policies_thresholds_object CHECK (jsonb_typeof(thresholds) = 'object'),
  CONSTRAINT drawer_policies_float_object CHECK (jsonb_typeof(default_float) = 'object')
);
${rls('drawer_policies')}
GRANT SELECT, INSERT ON TABLE drawer_policies TO __APP_USER__;
GRANT UPDATE (blind_count, max_recounts, thresholds, default_float, updated_by, updated_at)
  ON TABLE drawer_policies TO __APP_USER__;

-- ── drawers ──────────────────────────────────────────────────────────────
CREATE TABLE cash_drawers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id  uuid NOT NULL,
  name         text NOT NULL,
  tcr_code     text,
  currencies   text[] NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_drawers_location_fk FOREIGN KEY (location_id, tenant_id)
    REFERENCES locations (id, tenant_id),
  CONSTRAINT cash_drawers_name_present CHECK (btrim(name) <> ''),
  CONSTRAINT cash_drawers_tcr_shape CHECK (tcr_code IS NULL OR tcr_code ~ ${TCR_CODE}),
  CONSTRAINT cash_drawers_currencies CHECK (
    cardinality(currencies) BETWEEN 1 AND 3 AND currencies <@ ARRAY${CURRENCIES.replace('(', '[').replace(')', ']')}::text[])
);
CREATE UNIQUE INDEX cash_drawers_id_tenant_key ON cash_drawers (id, tenant_id);
CREATE UNIQUE INDEX cash_drawers_name_unique ON cash_drawers (tenant_id, lower(name));
${rls('cash_drawers')}
-- Retired, never deleted: sessions name the drawer forever.
GRANT SELECT, INSERT ON TABLE cash_drawers TO __APP_USER__;
GRANT UPDATE (name, tcr_code, currencies, is_active, updated_at) ON TABLE cash_drawers TO __APP_USER__;

-- ── sessions ─────────────────────────────────────────────────────────────
CREATE TABLE drawer_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  drawer_id            uuid NOT NULL,
  location_id          uuid NOT NULL,
  business_date        date NOT NULL,
  status               text NOT NULL DEFAULT 'open',
  blind                boolean NOT NULL,
  currencies           text[] NOT NULL,
  policy_snapshot      jsonb NOT NULL,
  opened_by            uuid NOT NULL,
  opened_at            timestamptz NOT NULL DEFAULT now(),
  counting_started_at  timestamptz,
  closed_by            uuid,
  closed_at            timestamptz,
  card_total           integer,
  card_batch_total     integer,
  card_batch_note      text,
  last_seq             integer NOT NULL DEFAULT 0,
  last_hash            text NOT NULL DEFAULT repeat('0', 64),
  CONSTRAINT drawer_sessions_drawer_fk FOREIGN KEY (drawer_id, tenant_id)
    REFERENCES cash_drawers (id, tenant_id),
  CONSTRAINT drawer_sessions_location_fk FOREIGN KEY (location_id, tenant_id)
    REFERENCES locations (id, tenant_id),
  CONSTRAINT drawer_sessions_opened_by_fk FOREIGN KEY (opened_by, tenant_id)
    REFERENCES users (id, tenant_id),
  CONSTRAINT drawer_sessions_closed_by_fk FOREIGN KEY (closed_by, tenant_id)
    REFERENCES users (id, tenant_id),
  CONSTRAINT drawer_sessions_status_known CHECK (
    status IN ('open','counting','pending_approval','closed','force_closed')),
  CONSTRAINT drawer_sessions_closed_consistent CHECK (
    (status IN ('closed','force_closed')) = (closed_at IS NOT NULL AND closed_by IS NOT NULL)),
  CONSTRAINT drawer_sessions_counting_consistent CHECK (
    status = 'open' OR counting_started_at IS NOT NULL OR status = 'force_closed'),
  CONSTRAINT drawer_sessions_currencies CHECK (cardinality(currencies) BETWEEN 1 AND 3),
  CONSTRAINT drawer_sessions_seq_sane CHECK (last_seq >= 0),
  CONSTRAINT drawer_sessions_hash_shape CHECK (last_hash ~ ${HASH}),
  CONSTRAINT drawer_sessions_card_sane CHECK (
    (card_total IS NULL OR card_total >= 0) AND (card_batch_total IS NULL OR card_batch_total >= 0))
);
CREATE UNIQUE INDEX drawer_sessions_id_tenant_key ON drawer_sessions (id, tenant_id);
CREATE UNIQUE INDEX drawer_sessions_one_per_drawer ON drawer_sessions (drawer_id)
  WHERE status IN ${OPEN_STATES};
CREATE UNIQUE INDEX drawer_sessions_one_per_person ON drawer_sessions (tenant_id, opened_by)
  WHERE status IN ${OPEN_STATES};
CREATE INDEX drawer_sessions_day_idx ON drawer_sessions (tenant_id, business_date DESC);
${rls('drawer_sessions')}
GRANT SELECT, INSERT ON TABLE drawer_sessions TO __APP_USER__;
GRANT UPDATE (status, counting_started_at, closed_by, closed_at, card_total, card_batch_total,
              card_batch_note, last_seq, last_hash)
  ON TABLE drawer_sessions TO __APP_USER__;

-- Forward only. The chain head (last_seq, last_hash) may still advance after
-- close: a cash payment voided later is recorded against the session it
-- belongs to.
CREATE FUNCTION drawer_session_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.drawer_id <> OLD.drawer_id
     OR NEW.opened_by <> OLD.opened_by OR NEW.opened_at <> OLD.opened_at
     OR NEW.blind <> OLD.blind OR NEW.policy_snapshot <> OLD.policy_snapshot THEN
    RAISE EXCEPTION 'A drawer session''s identity cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.last_seq < OLD.last_seq THEN
    RAISE EXCEPTION 'A drawer session''s event sequence cannot move backwards' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status IN ('closed','force_closed')
       AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.closed_by IS DISTINCT FROM OLD.closed_by
            OR NEW.card_total IS DISTINCT FROM OLD.card_total
            OR NEW.card_batch_total IS DISTINCT FROM OLD.card_batch_total) THEN
      RAISE EXCEPTION 'A closed drawer session cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Back to open from counting only before anything was counted: the patient
  -- who walks in to pay while the drawer is being closed. After a count, the
  -- count stands.
  IF OLD.status = 'counting' AND NEW.status = 'open' THEN
    IF EXISTS (SELECT 1 FROM drawer_counts WHERE session_id = OLD.id) THEN
      RAISE EXCEPTION 'A drawer that has been counted cannot be reopened' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.status = 'open' AND NEW.status IN ('counting','force_closed'))
     OR (OLD.status = 'counting' AND NEW.status IN ('pending_approval','closed','force_closed'))
     OR (OLD.status = 'pending_approval' AND NEW.status IN ('closed','force_closed')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A drawer session cannot move from % to %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER drawer_sessions_forward_only
  BEFORE UPDATE ON drawer_sessions
  FOR EACH ROW EXECUTE FUNCTION drawer_session_transition_guard();
CREATE TRIGGER drawer_sessions_no_delete
  BEFORE DELETE ON drawer_sessions
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- ── approvals ────────────────────────────────────────────────────────────
CREATE TABLE manager_approvals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action            text NOT NULL,
  subject_type      text NOT NULL,
  subject_id        uuid NOT NULL,
  approver_user_id  uuid NOT NULL,
  requested_by      uuid,
  method            text NOT NULL,
  reason            text NOT NULL,
  self_approved     boolean NOT NULL DEFAULT false,
  request_id        text,
  ip                text,
  user_agent        text,
  approved_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manager_approvals_approver_fk FOREIGN KEY (approver_user_id, tenant_id)
    REFERENCES users (id, tenant_id),
  CONSTRAINT manager_approvals_action_known CHECK (
    action IN ('drawer_variance','drawer_payout','drawer_force_close','drawer_add_float')),
  CONSTRAINT manager_approvals_method_known CHECK (method IN ('pin','session')),
  CONSTRAINT manager_approvals_reason_present CHECK (char_length(btrim(reason)) >= 3),
  -- Approving one's own count is no approval. The one exception is a clinic
  -- whose only administrator is also the person counting; the service allows
  -- it there, and the row says so.
  CONSTRAINT manager_approvals_not_self CHECK (
    self_approved OR requested_by IS NULL OR requested_by <> approver_user_id),
  CONSTRAINT manager_approvals_self_flag CHECK (
    NOT self_approved OR requested_by = approver_user_id)
);
CREATE UNIQUE INDEX manager_approvals_id_tenant_key ON manager_approvals (id, tenant_id);
CREATE INDEX manager_approvals_subject_idx ON manager_approvals (tenant_id, subject_type, subject_id);
${rls('manager_approvals')}
${appendOnly('manager_approvals')}

-- ── events ───────────────────────────────────────────────────────────────
CREATE TABLE drawer_events (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id              uuid NOT NULL,
  seq                     integer NOT NULL,
  type                    text NOT NULL,
  currency                text NOT NULL,
  amount                  integer NOT NULL,
  payment_id              uuid,
  fiscal_cash_deposit_id  uuid,
  approval_id             uuid,
  reason                  text,
  actor_user_id           uuid NOT NULL,
  request_id              text,
  ip                      text,
  user_agent              text,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  prev_hash               text NOT NULL,
  hash                    text NOT NULL,
  CONSTRAINT drawer_events_session_fk FOREIGN KEY (session_id, tenant_id)
    REFERENCES drawer_sessions (id, tenant_id),
  CONSTRAINT drawer_events_payment_fk FOREIGN KEY (payment_id, tenant_id)
    REFERENCES payments (id, tenant_id),
  CONSTRAINT drawer_events_approval_fk FOREIGN KEY (approval_id, tenant_id)
    REFERENCES manager_approvals (id, tenant_id),
  CONSTRAINT drawer_events_actor_fk FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES users (id, tenant_id),
  CONSTRAINT drawer_events_seq_positive CHECK (seq > 0),
  CONSTRAINT drawer_events_type_known CHECK (type IN
    ('open','cash_sale','cash_sale_voided','payout','drop','add_float','no_sale','post_close_void')),
  CONSTRAINT drawer_events_currency_known CHECK (currency IN ${CURRENCIES}),
  CONSTRAINT drawer_events_amount_sane CHECK (amount >= 0 AND (type <> 'no_sale' OR amount = 0)),
  CONSTRAINT drawer_events_payment_for_sales CHECK (
    (type IN ('cash_sale','cash_sale_voided','post_close_void')) = (payment_id IS NOT NULL)),
  CONSTRAINT drawer_events_reason_where_needed CHECK (
    type NOT IN ('payout','no_sale','add_float','cash_sale_voided','post_close_void')
    OR char_length(btrim(coalesce(reason, ''))) >= 3),
  CONSTRAINT drawer_events_approval_where_needed CHECK (
    type NOT IN ('payout','add_float') OR approval_id IS NOT NULL),
  CONSTRAINT drawer_events_hash_shape CHECK (hash ~ ${HASH} AND prev_hash ~ ${HASH})
);
CREATE UNIQUE INDEX drawer_events_session_seq ON drawer_events (session_id, seq);
CREATE INDEX drawer_events_payment_idx ON drawer_events (payment_id) WHERE payment_id IS NOT NULL;
${rls('drawer_events')}
${appendOnly('drawer_events')}

-- ── counts and reviews ───────────────────────────────────────────────────
CREATE TABLE drawer_counts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id     uuid NOT NULL,
  attempt_no     smallint NOT NULL,
  currency       text NOT NULL,
  denominations  jsonb NOT NULL,
  total          integer NOT NULL,
  expected       integer NOT NULL,
  counted_by     uuid NOT NULL,
  counted_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drawer_counts_session_fk FOREIGN KEY (session_id, tenant_id)
    REFERENCES drawer_sessions (id, tenant_id),
  CONSTRAINT drawer_counts_counted_by_fk FOREIGN KEY (counted_by, tenant_id)
    REFERENCES users (id, tenant_id),
  CONSTRAINT drawer_counts_currency_known CHECK (currency IN ${CURRENCIES}),
  CONSTRAINT drawer_counts_attempt_positive CHECK (attempt_no >= 1),
  CONSTRAINT drawer_counts_total_sane CHECK (total >= 0),
  CONSTRAINT drawer_counts_denominations_object CHECK (jsonb_typeof(denominations) = 'object')
);
CREATE UNIQUE INDEX drawer_counts_attempt ON drawer_counts (session_id, currency, attempt_no);
${rls('drawer_counts')}
${appendOnly('drawer_counts')}

CREATE TABLE drawer_session_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id   uuid NOT NULL,
  currency     text NOT NULL,
  expected     integer NOT NULL,
  counted      integer NOT NULL,
  variance     integer NOT NULL,
  band         text NOT NULL,
  note         text,
  reviewed_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drawer_reviews_session_fk FOREIGN KEY (session_id, tenant_id)
    REFERENCES drawer_sessions (id, tenant_id),
  CONSTRAINT drawer_reviews_reviewed_by_fk FOREIGN KEY (reviewed_by, tenant_id)
    REFERENCES users (id, tenant_id),
  CONSTRAINT drawer_reviews_currency_known CHECK (currency IN ${CURRENCIES}),
  CONSTRAINT drawer_reviews_band_known CHECK (band IN ('exact','note','approval')),
  CONSTRAINT drawer_reviews_variance_consistent CHECK (variance = counted - expected),
  CONSTRAINT drawer_reviews_note_where_needed CHECK (
    band = 'exact' OR char_length(btrim(coalesce(note, ''))) >= 10)
);
CREATE UNIQUE INDEX drawer_reviews_one_per_currency ON drawer_session_reviews (session_id, currency);
${rls('drawer_session_reviews')}
${appendOnly('drawer_session_reviews')}

-- ── payments, fiscal declarations, approval PINs ─────────────────────────
ALTER TABLE payments
  ADD COLUMN drawer_session_id uuid,
  ADD COLUMN idempotency_key text,
  ADD CONSTRAINT payments_drawer_session_fk FOREIGN KEY (drawer_session_id, tenant_id)
    REFERENCES drawer_sessions (id, tenant_id),
  ADD CONSTRAINT payments_drawer_only_cash CHECK (drawer_session_id IS NULL OR method = 'cash'),
  ADD CONSTRAINT payments_idempotency_key_shape CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$');
CREATE UNIQUE INDEX payments_idempotency_key_unique ON payments (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX payments_drawer_session_idx ON payments (drawer_session_id) WHERE drawer_session_id IS NOT NULL;

ALTER TABLE fiscal_cash_deposits
  ADD COLUMN drawer_session_id uuid,
  ADD CONSTRAINT fiscal_cash_deposits_session_fk FOREIGN KEY (drawer_session_id, tenant_id)
    REFERENCES drawer_sessions (id, tenant_id);

ALTER TABLE users
  ADD COLUMN approval_pin_hash text,
  ADD COLUMN approval_pin_failed_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN approval_pin_locked_until timestamptz,
  ADD CONSTRAINT users_approval_pin_attempts_sane CHECK (approval_pin_failed_attempts BETWEEN 0 AND 100);
`;

const DOWN = `
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_approval_pin_attempts_sane,
  DROP COLUMN IF EXISTS approval_pin_locked_until,
  DROP COLUMN IF EXISTS approval_pin_failed_attempts,
  DROP COLUMN IF EXISTS approval_pin_hash;

ALTER TABLE fiscal_cash_deposits
  DROP CONSTRAINT IF EXISTS fiscal_cash_deposits_session_fk,
  DROP COLUMN IF EXISTS drawer_session_id;

DROP INDEX IF EXISTS payments_drawer_session_idx;
DROP INDEX IF EXISTS payments_idempotency_key_unique;
ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_idempotency_key_shape,
  DROP CONSTRAINT IF EXISTS payments_drawer_only_cash,
  DROP CONSTRAINT IF EXISTS payments_drawer_session_fk,
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS drawer_session_id;

DROP TABLE IF EXISTS drawer_session_reviews;
DROP TABLE IF EXISTS drawer_counts;
DROP TABLE IF EXISTS drawer_events;
DROP TABLE IF EXISTS manager_approvals;
DROP TABLE IF EXISTS drawer_sessions;
DROP FUNCTION IF EXISTS drawer_session_transition_guard();
DROP TABLE IF EXISTS cash_drawers;
DROP TABLE IF EXISTS drawer_policies;
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
