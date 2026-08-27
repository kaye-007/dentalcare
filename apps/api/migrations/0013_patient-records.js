/**
 * 0013 — patient records: archival, emergency contact, medical history, documents
 *
 * Adds, in one migration because they are one feature:
 *   - patients.status gains 'archived', plus who/when/why it happened
 *   - emergency contact fields on the patient row (one contact, the 90% case)
 *   - patient_allergies    : structured, with severity — drives the chart warning
 *   - patient_conditions   : ongoing/resolved medical conditions
 *   - patient_medications  : current and historical medications
 *   - patient_documents    : X-ray / consent / referral metadata; bytes live in
 *                            object storage, only the key is stored here
 *
 * EVERY new table gets ENABLE + FORCE ROW LEVEL SECURITY with the same
 * tenant_isolation policy as migration 0003. A patient-records table without
 * RLS would leak medical history between clinics, so the policy is written
 * next to the table and never deferred.
 */

exports.shorthands = undefined;

const RLS = (pgm, table) => {
  pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`CREATE POLICY tenant_isolation ON ${table}
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);
};

exports.up = (pgm) => {
  /* ── 1. archival ──────────────────────────────────────────────────────
     Dental records carry retention duties and are referenced by invoices
     and appointments, so removal is a state change, never a DELETE. */
  pgm.sql('ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_status_check;');
  pgm.sql(`ALTER TABLE patients ADD CONSTRAINT patients_status_check
             CHECK (status IN ('active','inactive','archived'));`);

  pgm.addColumns('patients', {
    archived_at: { type: 'timestamptz' },
    archived_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    archive_reason: { type: 'text' },
  });

  // The three archive columns move together or not at all.
  pgm.sql(`ALTER TABLE patients ADD CONSTRAINT patients_archive_consistent
             CHECK (
               (status = 'archived' AND archived_at IS NOT NULL)
               OR (status <> 'archived' AND archived_at IS NULL)
             );`);

  /* ── 2. emergency contact ─────────────────────────────────────────── */
  pgm.addColumns('patients', {
    emergency_contact_name: { type: 'text' },
    emergency_contact_relationship: { type: 'text' },
    emergency_contact_phone: { type: 'text' },
  });

  // A contact without a phone number cannot be contacted in an emergency.
  pgm.sql(`ALTER TABLE patients ADD CONSTRAINT patients_emergency_contact_usable
             CHECK (
               emergency_contact_name IS NULL
               OR btrim(coalesce(emergency_contact_phone, '')) <> ''
             );`);

  /* ── 3. allergies ─────────────────────────────────────────────────── */
  pgm.createTable('patient_allergies', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    substance: { type: 'text', notNull: true },
    reaction: { type: 'text' },
    severity: {
      type: 'text',
      notNull: true,
      default: 'moderate',
      check: "severity IN ('mild','moderate','severe')",
    },
    notes: { type: 'text' },
    recorded_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE patient_allergies ADD CONSTRAINT allergy_substance_present
             CHECK (btrim(substance) <> '');`);
  // One row per substance per patient, case-insensitively.
  pgm.sql(`CREATE UNIQUE INDEX patient_allergy_unique
             ON patient_allergies (patient_id, lower(btrim(substance)));`);
  pgm.createIndex('patient_allergies', ['tenant_id', 'patient_id']);
  RLS(pgm, 'patient_allergies');

  /* ── 4. conditions ────────────────────────────────────────────────── */
  pgm.createTable('patient_conditions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'active',
      check: "status IN ('active','resolved')",
    },
    diagnosed_on: { type: 'date' },
    notes: { type: 'text' },
    recorded_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE patient_conditions ADD CONSTRAINT condition_name_present
             CHECK (btrim(name) <> '');`);
  pgm.createIndex('patient_conditions', ['tenant_id', 'patient_id']);
  RLS(pgm, 'patient_conditions');

  /* ── 5. medications ───────────────────────────────────────────────── */
  pgm.createTable('patient_medications', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    dosage: { type: 'text' },
    frequency: { type: 'text' },
    started_on: { type: 'date' },
    ended_on: { type: 'date' },
    notes: { type: 'text' },
    recorded_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`ALTER TABLE patient_medications ADD CONSTRAINT medication_name_present
             CHECK (btrim(name) <> '');`);
  pgm.sql(`ALTER TABLE patient_medications ADD CONSTRAINT medication_dates_ordered
             CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on);`);
  pgm.createIndex('patient_medications', ['tenant_id', 'patient_id']);
  // "Currently taking" = no end date. Partial index keeps that lookup cheap.
  pgm.sql(`CREATE INDEX patient_medications_current_idx
             ON patient_medications (patient_id) WHERE ended_on IS NULL;`);
  RLS(pgm, 'patient_medications');

  /* ── 6. documents ─────────────────────────────────────────────────────
     Bytes live in object storage. This table holds the metadata and the
     storage key; it is the only index of what exists, so rows are soft
     deleted (deleted_at) and reconciled against the bucket. */
  pgm.createTable('patient_documents', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    patient_id: { type: 'uuid', notNull: true, references: 'patients', onDelete: 'CASCADE' },
    storage_key: { type: 'text', notNull: true },
    file_name: { type: 'text', notNull: true },
    content_type: { type: 'text', notNull: true },
    byte_size: { type: 'bigint', notNull: true },
    /** SHA-256 of the bytes — detects duplicate uploads and silent corruption. */
    checksum: { type: 'text', notNull: true },
    kind: {
      type: 'text',
      notNull: true,
      default: 'other',
      check: "kind IN ('xray','photo','consent','referral','insurance','report','other')",
    },
    /** FDI tooth number when the image is of one tooth. */
    tooth: { type: 'smallint' },
    taken_on: { type: 'date' },
    caption: { type: 'text' },
    uploaded_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
    deleted_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
  });

  pgm.sql(`ALTER TABLE patient_documents ADD CONSTRAINT document_size_positive
             CHECK (byte_size > 0);`);
  // Same FDI ranges the odontogram uses in migration 0007.
  pgm.sql(`ALTER TABLE patient_documents ADD CONSTRAINT document_tooth_fdi_valid
             CHECK (
               tooth IS NULL OR (
                 tooth BETWEEN 11 AND 18 OR tooth BETWEEN 21 AND 28 OR
                 tooth BETWEEN 31 AND 38 OR tooth BETWEEN 41 AND 48 OR
                 tooth BETWEEN 51 AND 55 OR tooth BETWEEN 61 AND 65 OR
                 tooth BETWEEN 71 AND 75 OR tooth BETWEEN 81 AND 85
               )
             );`);
  pgm.sql(`ALTER TABLE patient_documents ADD CONSTRAINT document_delete_consistent
             CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));`);
  // A storage key must never be claimed by two rows.
  pgm.sql(`CREATE UNIQUE INDEX patient_documents_storage_key_unique
             ON patient_documents (storage_key);`);
  pgm.sql(`CREATE INDEX patient_documents_live_idx
             ON patient_documents (patient_id, created_at DESC) WHERE deleted_at IS NULL;`);
  pgm.createIndex('patient_documents', ['tenant_id', 'patient_id']);
  RLS(pgm, 'patient_documents');
};

exports.down = (pgm) => {
  pgm.dropTable('patient_documents');
  pgm.dropTable('patient_medications');
  pgm.dropTable('patient_conditions');
  pgm.dropTable('patient_allergies');

  pgm.sql('ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_emergency_contact_usable;');
  pgm.dropColumns('patients', [
    'emergency_contact_name',
    'emergency_contact_relationship',
    'emergency_contact_phone',
  ]);

  pgm.sql('ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_archive_consistent;');
  // Archived patients must land on a status the old constraint allows.
  pgm.sql(`UPDATE patients SET status = 'inactive' WHERE status = 'archived';`);
  pgm.dropColumns('patients', ['archived_at', 'archived_by', 'archive_reason']);
  pgm.sql('ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_status_check;');
  pgm.sql(`ALTER TABLE patients ADD CONSTRAINT patients_status_check
             CHECK (status IN ('active','inactive'));`);
};
