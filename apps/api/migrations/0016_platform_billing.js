/**
 * 0016 — what the clinic owes the vendor
 *
 * Everything money-shaped in this schema so far is the CLINIC billing its
 * PATIENTS. This table is the other direction, and the one the console had no
 * answer for: DentalCare billing the clinic for its subscription.
 *
 * Without it the vendor console can show a plan and a price and call the sum
 * "MRR", but cannot answer the question that actually decides whether a clinic
 * keeps its account — has this one paid. A plan is an intention; an invoice
 * with a due date and a payment against it is a fact.
 *
 * ── Why this table is invisible to the clinic plane ───────────────────────
 *
 * It carries NO grant to app_user, and therefore no RLS policy either. The
 * baseline's rule is explicit per-table grants and never GRANT ON ALL TABLES,
 * which means a table nobody grants is a table the clinic connection cannot
 * read — not by policy, but because the role has no privilege on it at all.
 * That is the stronger guarantee: a mistaken policy can leak, a missing
 * privilege cannot. `privileges.itest.ts` asserts the whole grant surface, and
 * a test here proves this table stayed off it.
 *
 * ── The period is the identity ────────────────────────────────────────────
 *
 * One invoice per clinic per billing period, enforced by a unique constraint
 * rather than by the code that generates them. Running the monthly billing
 * twice is then harmless: the second run conflicts and does nothing, which is
 * the behaviour you want from a job that a human triggers from a console and
 * may well double-click.
 *
 * Amounts are EUR minor units, matching `plans.price_monthly` — the console
 * already renders that with formatEuro. The plan's code, name and price are
 * SNAPSHOT onto the invoice: repricing a plan next year must not silently
 * rewrite what a clinic was billed last year.
 */

exports.shorthands = undefined;

const UP = `
CREATE TABLE subscription_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  number        text NOT NULL UNIQUE,

  period_start  date NOT NULL,
  period_end    date NOT NULL,

  -- Snapshots: what the clinic was on when this period was billed.
  plan_id       uuid REFERENCES plans (id),
  plan_code     text,
  plan_name     text,

  amount        integer NOT NULL,
  currency      text NOT NULL DEFAULT 'EUR',

  status        text NOT NULL DEFAULT 'open',
  issued_at     timestamptz NOT NULL DEFAULT now(),
  due_date      date NOT NULL,

  paid_at       timestamptz,
  paid_amount   integer,
  method        text,
  reference     text,
  note          text,

  created_by    uuid REFERENCES platform_admins (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT si_one_per_period UNIQUE (tenant_id, period_start),
  CONSTRAINT si_period_ordered CHECK (period_end > period_start),
  CONSTRAINT si_amount_not_negative CHECK (amount >= 0),
  CONSTRAINT si_status_known CHECK (status IN ('open', 'paid', 'void', 'uncollectible')),
  CONSTRAINT si_method_known CHECK (
    method IS NULL OR method IN ('bank_transfer', 'card', 'cash', 'other')),
  -- Paid means all three facts are present, and only then.
  CONSTRAINT si_paid_is_complete CHECK (
    (status = 'paid') = (paid_at IS NOT NULL AND paid_amount IS NOT NULL AND method IS NOT NULL))
);

-- The console's two questions: "who is overdue" and "this clinic's history".
CREATE INDEX si_open_by_due_idx ON subscription_invoices (status, due_date)
  WHERE status = 'open';
CREATE INDEX si_by_tenant_idx ON subscription_invoices (tenant_id, period_start DESC);

-- Belt as well as braces. The missing grant is what actually keeps this table
-- away from the clinic plane, but every table carrying a tenant_id in this
-- schema is RLS-enabled and FORCEd, and role.itest.ts enforces that as an
-- invariant rather than a habit. A table exempt "because it is platform-only"
-- is exactly the exemption someone later copies onto one that is not.
ALTER TABLE subscription_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscription_invoices
  USING (tenant_id = (current_setting('app.current_tenant_id', true))::uuid);

COMMENT ON TABLE subscription_invoices IS
  'Vendor-to-clinic subscription billing. Platform plane only: no app_user grant.';
`;

const DOWN = `
DROP TABLE IF EXISTS subscription_invoices;
`;

exports.up = (pgm) => {
  pgm.sql(UP);
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
