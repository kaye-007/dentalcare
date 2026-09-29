/**
 * 0026 — Idempotency-Key replay for the platform console
 *
 * The owner's decision of 2026-09-28: every route that moves money requires
 * an Idempotency-Key, and a request without one is refused (428). The clinic
 * plane has kept its keys in idempotency_keys since 0013, under the clinic's
 * row security. The console's subscription billing — issuing the month's
 * invoices, marking one paid, voiding one — belongs to no clinic, so its keys
 * cannot live there.
 *
 * platform_idempotency_keys has the same shape without the tenant: the key,
 * who sent it, a hash of the request, and the response to replay. Like every
 * console table it carries no grant at all (see 0005): the tenant role has no
 * business with it, and privileges.itest.ts checks that it cannot read it.
 */

exports.shorthands = undefined;

const UP = `
CREATE TABLE platform_idempotency_keys (
  key              text PRIMARY KEY,
  admin_id         uuid,
  request_method   text NOT NULL,
  request_path     text NOT NULL,
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'in_progress',
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT platform_idempotency_key_shape CHECK (key ~ '^[A-Za-z0-9_-]{16,128}$'),
  CONSTRAINT platform_idempotency_status_known CHECK (status IN ('in_progress', 'completed')),
  CONSTRAINT platform_idempotency_completed_consistent CHECK (
    (status = 'completed') = (completed_at IS NOT NULL AND response_status IS NOT NULL))
);

CREATE INDEX platform_idempotency_keys_age_idx ON platform_idempotency_keys (created_at);

REVOKE ALL ON TABLE platform_idempotency_keys FROM PUBLIC;
`;

const DOWN = `
DROP TABLE IF EXISTS platform_idempotency_keys;
`;

exports.up = (pgm) => {
  pgm.sql(UP);
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
