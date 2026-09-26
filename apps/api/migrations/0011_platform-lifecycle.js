/**
 * 0011 — a clinic can be deleted, and brought back
 *
 * The console could suspend and archive a clinic. It could not remove one,
 * and the only way to "remove" a clinic was a SQL session against production,
 * which is also the only way to lose one by accident.
 *
 * So deletion is a status with a clock, not a DELETE:
 *
 *   deleted        access is refused (the middleware allowlists 'active'),
 *                  every row is intact, and the console can restore it
 *   purge_after    when a person may purge it for good — 30 days by default.
 *                  Nothing purges automatically: dental records carry
 *                  retention duties, and a purge is a decision somebody makes
 *                  with the retention law in front of them, not a cron job.
 *   status_before_delete
 *                  kept for the record; a restore lands on 'suspended' so
 *                  that turning a restored clinic back on is its own act.
 */

exports.shorthands = undefined;

const UP = `
ALTER TABLE tenants DROP CONSTRAINT tenants_status_check;

ALTER TABLE tenants
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  ADD COLUMN deletion_reason text,
  ADD COLUMN purge_after timestamptz,
  ADD COLUMN status_before_delete text,
  ADD CONSTRAINT tenants_status_check CHECK (
    status IN ('active','suspended','archived','deleted')),
  ADD CONSTRAINT tenants_deleted_consistent CHECK (
    (status = 'deleted') = (deleted_at IS NOT NULL)
    AND (deleted_at IS NULL) = (purge_after IS NULL)
    AND (deleted_at IS NULL OR length(btrim(coalesce(deletion_reason, ''))) >= 3));
`;

const DOWN = `
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE status = 'deleted') THEN
    RAISE EXCEPTION 'Clinics are marked deleted; restore or archive them before rolling back 0011.';
  END IF;
END $$;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_deleted_consistent,
  DROP CONSTRAINT IF EXISTS tenants_status_check,
  DROP COLUMN IF EXISTS status_before_delete,
  DROP COLUMN IF EXISTS purge_after,
  DROP COLUMN IF EXISTS deletion_reason,
  DROP COLUMN IF EXISTS deleted_by,
  DROP COLUMN IF EXISTS deleted_at,
  ADD CONSTRAINT tenants_status_check CHECK (status IN ('active','suspended','archived'));
`;

exports.up = (pgm) => {
  pgm.sql(UP);
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
