/**
 * 0014 — scheduling engine: operatories, statuses, availability, hard conflicts
 *
 * Adds:
 *   - btree_gist              : lets an EXCLUDE constraint mix `=` on a uuid
 *                               with `&&` on a time range in one index
 *   - operatories             : treatment rooms / chairs
 *   - appointments.operatory_id + lifecycle timestamps + cancellation reason
 *   - two new statuses        : checked_in, in_progress
 *   - EXCLUDE constraints     : double-booking becomes impossible, not unlikely
 *   - staff_availability      : per-dentist weekly working schedule
 *   - appointment_status_events : append-only audit of every transition
 *
 * WHY EXCLUDE RATHER THAN A SELECT CHECK
 * The previous guard read the table, then inserted. Two receptionists booking
 * the same slot in the same instant both passed the read and both rows landed.
 * An EXCLUDE constraint is evaluated by the index at write time, so the second
 * writer is rejected by the database no matter how the requests interleave.
 *
 * EXCLUDE vs ROW-LEVEL SECURITY
 * Constraints are enforced below RLS and therefore see rows belonging to other
 * tenants. That is safe here, and deliberately so: the constrained columns are
 * staff_id and operatory_id, both tenant-scoped foreign keys. A clinic can only
 * ever reference its own staff and its own rooms, so its ranges can never
 * collide with another clinic's rows and no cross-tenant existence can be
 * inferred from a violation.
 *
 * SPELLING
 * 'cancelled' is kept as-is. The column already holds that value in live rows,
 * and renaming a status to change one letter is churn, not a feature.
 */

exports.shorthands = undefined;

/** Statuses during which a chair and a dentist are genuinely occupied. */
const BLOCKING = "('scheduled','checked_in','in_progress')";

exports.up = (pgm) => {
  // gist indexes on a plain uuid `=` need btree_gist; ranges alone do not.
  pgm.createExtension('btree_gist', { ifNotExists: true });

  // Postgres ships range types for int/num/ts/tstz/date but NOT for `time`,
  // and a weekly schedule is genuinely a time-of-day range. Define it once so
  // staff_availability can exclude overlapping shifts with the same mechanism
  // the appointments table uses. CREATE TYPE has no IF NOT EXISTS.
  pgm.sql(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'timerange') THEN
        CREATE TYPE timerange AS RANGE (subtype = time);
      END IF;
    END $$;`);

  /* ── 1. operatories (treatment rooms / chairs) ─────────────────────── */
  pgm.createTable('operatories', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    /** Free text: "Surgery 1", "Hygiene bay", "Ortho chair". */
    description: { type: 'text' },
    /** Display order in the calendar; ties break by name. */
    sort_order: { type: 'integer', notNull: true, default: 0 },
    /** Colour chip so a room is identifiable at a glance in month view. */
    color: { type: 'text' },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE operatories ADD CONSTRAINT operatory_name_present
             CHECK (btrim(name) <> '');`);
  pgm.sql(`ALTER TABLE operatories ADD CONSTRAINT operatory_color_hex
             CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$');`);
  pgm.sql(`CREATE UNIQUE INDEX operatories_tenant_name_unique
             ON operatories (tenant_id, lower(btrim(name)));`);
  pgm.createIndex('operatories', ['tenant_id', 'sort_order']);

  pgm.sql('ALTER TABLE operatories ENABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE operatories FORCE ROW LEVEL SECURITY;');
  pgm.sql(`CREATE POLICY tenant_isolation ON operatories
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);

  /* ── 2. appointments: room, lifecycle, cancellation ───────────────── */
  pgm.addColumns('appointments', {
    operatory_id: { type: 'uuid', references: 'operatories', onDelete: 'SET NULL' },
    checked_in_at: { type: 'timestamptz' },
    in_progress_at: { type: 'timestamptz' },
    completed_at: { type: 'timestamptz' },
    cancelled_at: { type: 'timestamptz' },
    cancel_reason: { type: 'text' },
    /** Set when a booking is moved, so "rescheduled" is distinguishable. */
    rescheduled_at: { type: 'timestamptz' },
  });

  pgm.sql('ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;');
  pgm.sql(`ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
             CHECK (status IN ('scheduled','checked_in','in_progress','completed','cancelled','no_show'));`);

  // Backfill BEFORE the constraints below, not after. Adding a CHECK to a
  // populated table validates every existing row immediately, so any database
  // that already held a completed or cancelled appointment failed here with
  // "constraint is violated by some row" and rolled the whole migration back.
  // On an empty database this ordering was invisible, which is why it shipped.
  // updated_at is the best evidence available of when a row reached its state.
  pgm.sql(`UPDATE appointments SET completed_at = coalesce(updated_at, now())
            WHERE status = 'completed' AND completed_at IS NULL;`);
  pgm.sql(`UPDATE appointments SET cancelled_at = coalesce(updated_at, now())
            WHERE status = 'cancelled' AND cancelled_at IS NULL;`);

  // Terminal states must carry their timestamp, and vice versa. This makes an
  // appointment that is "completed" with no completion time unrepresentable.
  pgm.sql(`ALTER TABLE appointments ADD CONSTRAINT appointment_completed_consistent
             CHECK ((status = 'completed') = (completed_at IS NOT NULL));`);
  pgm.sql(`ALTER TABLE appointments ADD CONSTRAINT appointment_cancelled_consistent
             CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));`);

  /* ── 3. hard conflict prevention ──────────────────────────────────── */
  // One dentist cannot be in two places at once.
  pgm.sql(`ALTER TABLE appointments ADD CONSTRAINT appointment_no_staff_overlap
             EXCLUDE USING gist (
               staff_id WITH =,
               tstzrange(starts_at, ends_at, '[)') WITH &&
             )
             WHERE (staff_id IS NOT NULL AND status IN ${BLOCKING});`);

  // One chair cannot hold two patients at once.
  pgm.sql(`ALTER TABLE appointments ADD CONSTRAINT appointment_no_operatory_overlap
             EXCLUDE USING gist (
               operatory_id WITH =,
               tstzrange(starts_at, ends_at, '[)') WITH &&
             )
             WHERE (operatory_id IS NOT NULL AND status IN ${BLOCKING});`);

  // A patient cannot be in two appointments at once either — the mistake a
  // busy front desk actually makes when two people book the same person.
  pgm.sql(`ALTER TABLE appointments ADD CONSTRAINT appointment_no_patient_overlap
             EXCLUDE USING gist (
               patient_id WITH =,
               tstzrange(starts_at, ends_at, '[)') WITH &&
             )
             WHERE (status IN ${BLOCKING});`);

  pgm.createIndex('appointments', ['tenant_id', 'operatory_id', 'starts_at']);
  pgm.createIndex('appointments', ['tenant_id', 'status', 'starts_at']);

  /* ── 4. per-dentist weekly availability ───────────────────────────── */
  pgm.createTable('staff_availability', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    staff_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    /** 0 = Sunday … 6 = Saturday, matching JavaScript's Date#getDay(). */
    weekday: { type: 'smallint', notNull: true },
    /** Local clinic time, not UTC — a dentist works 09:00 wherever they are. */
    starts_at: { type: 'time', notNull: true },
    ends_at: { type: 'time', notNull: true },
    /** Optional room this dentist normally occupies on that day. */
    operatory_id: { type: 'uuid', references: 'operatories', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE staff_availability ADD CONSTRAINT availability_weekday_valid
             CHECK (weekday BETWEEN 0 AND 6);`);
  pgm.sql(`ALTER TABLE staff_availability ADD CONSTRAINT availability_times_ordered
             CHECK (ends_at > starts_at);`);
  // Two overlapping shifts on the same weekday are a data-entry error, and a
  // time range on a fixed weekday excludes cleanly.
  pgm.sql(`ALTER TABLE staff_availability ADD CONSTRAINT availability_no_overlap
             EXCLUDE USING gist (
               staff_id WITH =,
               weekday WITH =,
               timerange(starts_at, ends_at, '[)') WITH &&
             );`);
  pgm.createIndex('staff_availability', ['tenant_id', 'staff_id', 'weekday']);

  pgm.sql('ALTER TABLE staff_availability ENABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE staff_availability FORCE ROW LEVEL SECURITY;');
  pgm.sql(`CREATE POLICY tenant_isolation ON staff_availability
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);

  /* ── 5. status transition audit ───────────────────────────────────── */
  pgm.createTable('appointment_status_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    appointment_id: { type: 'uuid', notNull: true, references: 'appointments', onDelete: 'CASCADE' },
    /** NULL on the row recorded at creation. */
    from_status: { type: 'text' },
    to_status: { type: 'text', notNull: true },
    note: { type: 'text' },
    actor_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE appointment_status_events ADD CONSTRAINT status_event_changes_something
             CHECK (from_status IS NULL OR from_status <> to_status);`);
  pgm.createIndex('appointment_status_events', ['appointment_id', 'created_at']);
  pgm.createIndex('appointment_status_events', ['tenant_id', 'created_at']);

  pgm.sql('ALTER TABLE appointment_status_events ENABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE appointment_status_events FORCE ROW LEVEL SECURITY;');
  pgm.sql(`CREATE POLICY tenant_isolation ON appointment_status_events
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);

  /* ── 6. (backfill moved to step 2, above the constraints) ─────────── */
};

exports.down = (pgm) => {
  pgm.dropTable('appointment_status_events');
  pgm.dropTable('staff_availability');

  pgm.sql('ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointment_no_patient_overlap;');
  pgm.sql('ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointment_no_operatory_overlap;');
  pgm.sql('ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointment_no_staff_overlap;');
  pgm.sql('ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointment_cancelled_consistent;');
  pgm.sql('ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointment_completed_consistent;');

  pgm.dropIndex('appointments', ['tenant_id', 'status', 'starts_at'], { ifExists: true });
  pgm.dropIndex('appointments', ['tenant_id', 'operatory_id', 'starts_at'], { ifExists: true });

  // Statuses added by this migration must land somewhere the old check allows.
  pgm.sql(`UPDATE appointments SET status = 'scheduled'
            WHERE status IN ('checked_in','in_progress');`);
  pgm.sql('ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;');
  pgm.sql(`ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
             CHECK (status IN ('scheduled','completed','cancelled','no_show'));`);

  pgm.dropColumns('appointments', [
    'operatory_id', 'checked_in_at', 'in_progress_at', 'completed_at',
    'cancelled_at', 'cancel_reason', 'rescheduled_at',
  ]);

  pgm.dropTable('operatories');
  pgm.sql('DROP TYPE IF EXISTS timerange;');
  pgm.dropExtension('btree_gist', { ifExists: true });
};
