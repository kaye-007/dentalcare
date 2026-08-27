/**
 * 0015 — clinical charting, perio, and treatment plans
 *
 *   procedure_codes       : the clinic's own code catalogue (CDT / ICD-10 /
 *                           custom). Deliberately EMPTY on install — see below.
 *   tooth_conditions      : the odontogram. Surface-aware, typed conditions,
 *                           permanent AND primary dentition.
 *   perio_exams           : one periodontal examination
 *   perio_measurements    : six sites per tooth within an exam
 *   treatment_plans       : a proposal built from several procedures
 *   treatment_plan_items  : the priced lines of a plan
 *   clinical_procedures   : what was actually done, and by whom
 *
 * tooth_records is RETIRED here. Its rows are copied into tooth_conditions
 * first as whole-tooth findings — the old table had no surface column, so
 * inventing one would be fabricating clinical detail. Anything whose free-text
 * condition does not map to a known finding is preserved as a 'watch' with the
 * original text kept in the note, so no observation is silently lost.
 *
 * NO CDT CODES ARE SHIPPED. CDT is ADA copyright and cannot be redistributed
 * in this repository. The catalogue table is created empty for the clinic to
 * populate from its own licensed copy.
 *
 * MONEY is integers in whole currency units, matching invoices and treatments.
 * There is no insurance model: this build targets the Albanian market, where
 * treatment is paid directly, so the cost engine is fee → discount → total.
 */

exports.shorthands = undefined;

const RLS = (pgm, table) => {
  pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`CREATE POLICY tenant_isolation ON ${table}
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);
};

/** Every FDI tooth: permanent 11–48, primary 51–85. */
const TOOTH_CHECK = (col) => `(
  (${col} BETWEEN 11 AND 18) OR (${col} BETWEEN 21 AND 28) OR
  (${col} BETWEEN 31 AND 38) OR (${col} BETWEEN 41 AND 48) OR
  (${col} BETWEEN 51 AND 55) OR (${col} BETWEEN 61 AND 65) OR
  (${col} BETWEEN 71 AND 75) OR (${col} BETWEEN 81 AND 85)
)`;

const CONDITIONS =
  "('caries','restored','crown','bridge','veneer','root_canal','implant'," +
  "'extracted','missing','impacted','fractured','sealant','watch')";

exports.up = (pgm) => {
  /* ── 1. procedure code catalogue ──────────────────────────────────── */
  pgm.createTable('procedure_codes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    system: {
      type: 'text',
      notNull: true,
      default: 'custom',
      check: "system IN ('CDT','ICD10','custom')",
    },
    code: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true },
    /** Default fee in whole currency units. Overridable per plan line. */
    default_fee: { type: 'integer', notNull: true, default: 0 },
    /** Optional link to the existing treatments catalogue. */
    treatment_id: { type: 'uuid', references: 'treatments', onDelete: 'SET NULL' },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE procedure_codes ADD CONSTRAINT procedure_code_present
             CHECK (btrim(code) <> '' AND btrim(description) <> '');`);
  pgm.sql(`ALTER TABLE procedure_codes ADD CONSTRAINT procedure_code_fee_sane
             CHECK (default_fee >= 0);`);
  pgm.sql(`CREATE UNIQUE INDEX procedure_codes_unique
             ON procedure_codes (tenant_id, system, upper(btrim(code)));`);
  pgm.createIndex('procedure_codes', ['tenant_id', 'is_active']);
  RLS(pgm, 'procedure_codes');

  /* ── 2. odontogram ────────────────────────────────────────────────── */
  pgm.createTable('tooth_conditions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    /** FDI. Permanent 11–48, primary 51–85. */
    tooth: { type: 'smallint', notNull: true },
    /** M/D/O/I/F/L, or NULL for a whole-tooth finding. */
    surface: { type: 'text', check: "surface IN ('M','D','O','I','F','L')" },
    condition: { type: 'text', notNull: true, check: `condition IN ${CONDITIONS}` },
    status: {
      type: 'text',
      notNull: true,
      default: 'active',
      check: "status IN ('active','treated','resolved')",
    },
    note: { type: 'text' },
    /** The procedure that resolved this finding, once it has been treated. */
    resolved_by_procedure_id: { type: 'uuid' },
    dentist_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE tooth_conditions ADD CONSTRAINT tooth_conditions_fdi_valid
             CHECK ${TOOTH_CHECK('tooth')};`);

  // Occlusal exists only on posteriors, incisal only on anteriors. Position is
  // the second FDI digit, so this is checkable in the schema rather than left
  // to application code that a future endpoint might forget.
  pgm.sql(`ALTER TABLE tooth_conditions ADD CONSTRAINT tooth_conditions_surface_anatomical
             CHECK (
               surface IS NULL
               OR (surface = 'O' AND (tooth % 10) >= 4)
               OR (surface = 'I' AND (tooth % 10) <= 3)
               OR surface IN ('M','D','F','L')
             );`);

  // Structural findings describe the whole tooth; a surface would be nonsense.
  pgm.sql(`ALTER TABLE tooth_conditions ADD CONSTRAINT tooth_conditions_whole_tooth
             CHECK (
               condition NOT IN ('extracted','missing','implant','impacted','crown','bridge','root_canal')
               OR surface IS NULL
             );`);

  // One active finding per (tooth, surface, condition). Re-charting the same
  // caries must update, not accumulate duplicates the dentist has to reconcile.
  pgm.sql(`CREATE UNIQUE INDEX tooth_conditions_active_unique
             ON tooth_conditions (patient_id, tooth, coalesce(surface, '*'), condition)
             WHERE status = 'active';`);
  pgm.createIndex('tooth_conditions', ['tenant_id', 'patient_id']);
  pgm.createIndex('tooth_conditions', ['tenant_id', 'patient_id', 'tooth']);
  RLS(pgm, 'tooth_conditions');

  /* ── 3. periodontal charting ──────────────────────────────────────── */
  pgm.createTable('perio_exams', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    examined_on: { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    clinician_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    note: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
  });
  pgm.createIndex('perio_exams', ['tenant_id', 'patient_id', 'examined_on']);
  RLS(pgm, 'perio_exams');

  pgm.createTable('perio_measurements', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    exam_id: { type: 'uuid', notNull: true, references: 'perio_exams', onDelete: 'CASCADE' },
    tooth: { type: 'smallint', notNull: true },
    /**
     * The six standard sites: buccal and lingual × mesial/mid/distal.
     * MB DB = mesio/disto-buccal, B = mid-buccal, and likewise lingually.
     */
    site: {
      type: 'text',
      notNull: true,
      check: "site IN ('MB','B','DB','ML','L','DL')",
    },
    /** Millimetres. 0–15 covers any real probe reading. */
    probing_depth: { type: 'smallint' },
    /** Negative = tissue coronal to the CEJ (overgrowth), positive = recession. */
    recession: { type: 'smallint' },
    bleeding: { type: 'boolean', notNull: true, default: false },
    suppuration: { type: 'boolean', notNull: true, default: false },
    plaque: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE perio_measurements ADD CONSTRAINT perio_tooth_valid
             CHECK ${TOOTH_CHECK('tooth')};`);
  pgm.sql(`ALTER TABLE perio_measurements ADD CONSTRAINT perio_depth_range
             CHECK (probing_depth IS NULL OR probing_depth BETWEEN 0 AND 15);`);
  pgm.sql(`ALTER TABLE perio_measurements ADD CONSTRAINT perio_recession_range
             CHECK (recession IS NULL OR recession BETWEEN -5 AND 15);`);
  pgm.sql(`CREATE UNIQUE INDEX perio_measurement_unique
             ON perio_measurements (exam_id, tooth, site);`);
  pgm.createIndex('perio_measurements', ['tenant_id', 'exam_id']);
  RLS(pgm, 'perio_measurements');

  /**
   * Mobility and furcation are properties of the TOOTH, not of a site, so they
   * live on their own row per tooth per exam rather than being repeated six
   * times and risking disagreement between sites.
   */
  pgm.createTable('perio_tooth_findings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    exam_id: { type: 'uuid', notNull: true, references: 'perio_exams', onDelete: 'CASCADE' },
    tooth: { type: 'smallint', notNull: true },
    /** Miller classification 0–3. */
    mobility: { type: 'smallint' },
    /** Glickman furcation grade 0–3. */
    furcation: { type: 'smallint' },
    note: { type: 'text' },
  });
  pgm.sql(`ALTER TABLE perio_tooth_findings ADD CONSTRAINT perio_findings_tooth_valid
             CHECK ${TOOTH_CHECK('tooth')};`);
  pgm.sql(`ALTER TABLE perio_tooth_findings ADD CONSTRAINT perio_mobility_range
             CHECK (mobility IS NULL OR mobility BETWEEN 0 AND 3);`);
  pgm.sql(`ALTER TABLE perio_tooth_findings ADD CONSTRAINT perio_furcation_range
             CHECK (furcation IS NULL OR furcation BETWEEN 0 AND 3);`);
  pgm.sql(`CREATE UNIQUE INDEX perio_tooth_finding_unique
             ON perio_tooth_findings (exam_id, tooth);`);
  RLS(pgm, 'perio_tooth_findings');

  /* ── 4. treatment plans ───────────────────────────────────────────── */
  pgm.createTable('treatment_plans', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'draft',
      check: "status IN ('draft','proposed','accepted','in_progress','completed','declined')",
    },
    note: { type: 'text' },
    /** Plan-wide discount in whole currency units, applied after line totals. */
    discount_amount: { type: 'integer', notNull: true, default: 0 },
    proposed_at: { type: 'timestamptz' },
    accepted_at: { type: 'timestamptz' },
    declined_at: { type: 'timestamptz' },
    decline_reason: { type: 'text' },
    completed_at: { type: 'timestamptz' },
    dentist_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE treatment_plans ADD CONSTRAINT plan_title_present
             CHECK (btrim(title) <> '');`);
  pgm.sql(`ALTER TABLE treatment_plans ADD CONSTRAINT plan_discount_sane
             CHECK (discount_amount >= 0);`);
  pgm.sql(`ALTER TABLE treatment_plans ADD CONSTRAINT plan_accepted_consistent
             CHECK ((status = 'accepted') <= (accepted_at IS NOT NULL));`);
  pgm.sql(`ALTER TABLE treatment_plans ADD CONSTRAINT plan_declined_consistent
             CHECK ((status = 'declined') = (declined_at IS NOT NULL));`);
  pgm.createIndex('treatment_plans', ['tenant_id', 'patient_id', 'status']);
  RLS(pgm, 'treatment_plans');

  pgm.createTable('treatment_plan_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    plan_id: { type: 'uuid', notNull: true, references: 'treatment_plans', onDelete: 'CASCADE' },
    /** Optional: some procedures are not tooth-specific (a scale and polish). */
    tooth: { type: 'smallint' },
    /** Surfaces this line treats, e.g. {M,O}. Empty for whole-tooth work. */
    surfaces: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    procedure_code_id: { type: 'uuid', references: 'procedure_codes', onDelete: 'SET NULL' },
    treatment_id: { type: 'uuid', references: 'treatments', onDelete: 'SET NULL' },
    description: { type: 'text', notNull: true },
    quantity: { type: 'integer', notNull: true, default: 1 },
    /** Fee per unit, whole currency units, snapshotted at planning time. */
    unit_fee: { type: 'integer', notNull: true, default: 0 },
    /** Per-line discount in whole currency units. */
    discount_amount: { type: 'integer', notNull: true, default: 0 },
    status: {
      type: 'text',
      notNull: true,
      default: 'planned',
      check: "status IN ('planned','scheduled','completed','cancelled')",
    },
    /** Ordering within the plan, and clinical sequencing. */
    sort_order: { type: 'integer', notNull: true, default: 0 },
    note: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE treatment_plan_items ADD CONSTRAINT plan_item_tooth_valid
             CHECK (tooth IS NULL OR ${TOOTH_CHECK('tooth')});`);
  pgm.sql(`ALTER TABLE treatment_plan_items ADD CONSTRAINT plan_item_description_present
             CHECK (btrim(description) <> '');`);
  pgm.sql(`ALTER TABLE treatment_plan_items ADD CONSTRAINT plan_item_quantity_positive
             CHECK (quantity > 0);`);
  pgm.sql(`ALTER TABLE treatment_plan_items ADD CONSTRAINT plan_item_fee_sane
             CHECK (unit_fee >= 0 AND discount_amount >= 0);`);
  // A discount cannot exceed what is being discounted.
  pgm.sql(`ALTER TABLE treatment_plan_items ADD CONSTRAINT plan_item_discount_bounded
             CHECK (discount_amount <= unit_fee * quantity);`);
  // Only real surface codes, and only where the anatomy allows.
  pgm.sql(`ALTER TABLE treatment_plan_items ADD CONSTRAINT plan_item_surfaces_valid
             CHECK (surfaces <@ ARRAY['M','D','O','I','F','L']::text[]);`);
  pgm.createIndex('treatment_plan_items', ['tenant_id', 'plan_id']);
  RLS(pgm, 'treatment_plan_items');

  /* ── 5. procedure log — what was actually done ────────────────────── */
  pgm.createTable('clinical_procedures', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    tooth: { type: 'smallint' },
    surfaces: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    procedure_code_id: { type: 'uuid', references: 'procedure_codes', onDelete: 'SET NULL' },
    /** Diagnosis code, kept separate from the procedure code. */
    diagnosis_code_id: { type: 'uuid', references: 'procedure_codes', onDelete: 'SET NULL' },
    treatment_id: { type: 'uuid', references: 'treatments', onDelete: 'SET NULL' },
    plan_item_id: { type: 'uuid', references: 'treatment_plan_items', onDelete: 'SET NULL' },
    appointment_id: { type: 'uuid', references: 'appointments', onDelete: 'SET NULL' },
    description: { type: 'text', notNull: true },
    /** Who performed it — clinical attribution, not who typed it in. */
    clinician_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    status: {
      type: 'text',
      notNull: true,
      default: 'completed',
      check: "status IN ('planned','in_progress','completed','cancelled')",
    },
    fee: { type: 'integer', notNull: true, default: 0 },
    performed_on: { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    note: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE clinical_procedures ADD CONSTRAINT procedure_tooth_valid
             CHECK (tooth IS NULL OR ${TOOTH_CHECK('tooth')});`);
  pgm.sql(`ALTER TABLE clinical_procedures ADD CONSTRAINT procedure_description_present
             CHECK (btrim(description) <> '');`);
  pgm.sql(`ALTER TABLE clinical_procedures ADD CONSTRAINT procedure_fee_sane
             CHECK (fee >= 0);`);
  pgm.sql(`ALTER TABLE clinical_procedures ADD CONSTRAINT procedure_surfaces_valid
             CHECK (surfaces <@ ARRAY['M','D','O','I','F','L']::text[]);`);
  pgm.createIndex('clinical_procedures', ['tenant_id', 'patient_id', 'performed_on']);
  pgm.createIndex('clinical_procedures', ['tenant_id', 'clinician_id']);
  RLS(pgm, 'clinical_procedures');

  // Close the loop: a tooth condition can name the procedure that resolved it.
  pgm.sql(`ALTER TABLE tooth_conditions
             ADD CONSTRAINT tooth_conditions_resolved_by_fk
             FOREIGN KEY (resolved_by_procedure_id)
             REFERENCES clinical_procedures(id) ON DELETE SET NULL;`);

  /* ── 6. retire tooth_records, preserving its observations ─────────── */
  // Free-text conditions are matched case-insensitively against the typed set;
  // anything unrecognised becomes a 'watch' carrying the original wording, so
  // a clinician still sees what was written. No surface is invented: the old
  // table had none, and guessing one would fabricate clinical detail.
  pgm.sql(`
    INSERT INTO tooth_conditions
      (tenant_id, patient_id, tooth, surface, condition, status, note,
       dentist_id, recorded_at, created_by)
    SELECT r.tenant_id, r.patient_id, r.tooth, NULL,
           CASE lower(btrim(r.condition))
             WHEN 'caries' THEN 'caries'
             WHEN 'restored' THEN 'restored'
             WHEN 'filling' THEN 'restored'
             WHEN 'crown' THEN 'crown'
             WHEN 'bridge' THEN 'bridge'
             WHEN 'veneer' THEN 'veneer'
             WHEN 'root canal' THEN 'root_canal'
             WHEN 'root_canal' THEN 'root_canal'
             WHEN 'implant' THEN 'implant'
             WHEN 'extracted' THEN 'extracted'
             WHEN 'missing' THEN 'missing'
             WHEN 'impacted' THEN 'impacted'
             WHEN 'fractured' THEN 'fractured'
             WHEN 'sealant' THEN 'sealant'
             ELSE 'watch'
           END,
           CASE WHEN r.status = 'done' THEN 'treated' ELSE 'active' END,
           CASE
             WHEN lower(btrim(r.condition)) IN (
               'caries','restored','filling','crown','bridge','veneer',
               'root canal','root_canal','implant','extracted','missing',
               'impacted','fractured','sealant')
               THEN r.note
             ELSE btrim(concat_ws(' — ', 'Migrated from odontogram: ' || r.condition, r.note))
           END,
           r.dentist_id, r.recorded_at, r.created_by
      FROM tooth_records r
      -- The old CHECK allowed only permanent teeth, but guard anyway.
      WHERE ${TOOTH_CHECK('r.tooth')}
    ON CONFLICT DO NOTHING;
  `);

  pgm.dropTable('tooth_records');
};

exports.down = (pgm) => {
  // Recreate tooth_records exactly as migration 0007 left it, then copy back
  // whole-tooth findings. Surface-level detail cannot survive the round trip —
  // the old shape has nowhere to put it.
  pgm.createTable('tooth_records', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    tooth: { type: 'smallint', notNull: true },
    condition: { type: 'text', notNull: true },
    treatment_id: { type: 'uuid', references: 'treatments', onDelete: 'SET NULL' },
    dentist_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    status: {
      type: 'text', notNull: true, default: 'pending',
      check: "status IN ('pending','done')",
    },
    note: { type: 'text' },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
  });
  pgm.sql(`ALTER TABLE tooth_records ADD CONSTRAINT tooth_fdi_valid CHECK (
    (tooth BETWEEN 11 AND 18) OR (tooth BETWEEN 21 AND 28) OR
    (tooth BETWEEN 31 AND 38) OR (tooth BETWEEN 41 AND 48));`);
  pgm.createIndex('tooth_records', ['tenant_id', 'patient_id']);
  pgm.createIndex('tooth_records', ['tenant_id', 'patient_id', 'tooth']);
  RLS(pgm, 'tooth_records');

  pgm.sql(`
    INSERT INTO tooth_records
      (tenant_id, patient_id, tooth, condition, dentist_id, status, note, recorded_at, created_by)
    SELECT tenant_id, patient_id, tooth, condition, dentist_id,
           CASE WHEN status = 'active' THEN 'pending' ELSE 'done' END,
           note, recorded_at, created_by
      FROM tooth_conditions
     WHERE tooth BETWEEN 11 AND 48;
  `);

  pgm.dropTable('clinical_procedures');
  pgm.dropTable('treatment_plan_items');
  pgm.dropTable('treatment_plans');
  pgm.dropTable('perio_tooth_findings');
  pgm.dropTable('perio_measurements');
  pgm.dropTable('perio_exams');
  pgm.dropTable('tooth_conditions');
  pgm.dropTable('procedure_codes');
};
