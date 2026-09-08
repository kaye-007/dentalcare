/**
 * 0018 — the clinic audit log, and money that cannot be deleted
 *
 * Two halves of one requirement: reception must be able to fix a mistake, and
 * must not be able to make one disappear.
 *
 *   - clinic_audit_log : who did what, in the same transaction as the thing
 *                        they did. Tenant-scoped, append-only, and enforced as
 *                        append-only by the database rather than by the app.
 *   - payments/expenses: gain voided_at / voided_by / void_reason. Nothing is
 *                        ever removed; a mistake is reversed and stays visible.
 *
 * ── Why the privileges change, not just the code ──────────────────────────
 *
 * A rule that lives only in a service is a rule that survives exactly as long
 * as nobody writes a second code path. So:
 *
 *   - DELETE is revoked from app_user on payments, invoices, expenses and
 *     ledger_entries. The application role has no way to issue one at all.
 *   - UPDATE on payments and expenses is narrowed to the three void columns.
 *     The app can mark a payment void; it cannot change its amount, method or
 *     date. That is a column-level grant, so it holds for any future code too.
 *   - ledger_entries loses UPDATE entirely. 0016 called it append-only in a
 *     comment; this makes it true.
 *
 * app_user is the only role the API ever connects as. The privileged
 * migration/platform role keeps its DML on the money tables, so the admin
 * plane is unaffected by the REVOKEs above.
 *
 * It is NOT, however, still able to delete a clinic outright — an earlier
 * version of this comment claimed it was, and that was wrong. clinic_audit_log
 * cascades from `tenants`, and the trigger below fires for every role
 * including the table owner, so `DELETE FROM tenants` is refused for any
 * clinic that has recorded a single action. Nothing ships that does this: the
 * console suspends and archives, and has no delete. Removing a clinic for
 * real means dropping the trigger first, deliberately, exactly as described
 * under "immutable even to the owner" below.
 *
 * ── The audit log is immutable even to the owner ───────────────────────────
 *
 * REVOKE alone would still let a future migration hand the privilege back, so
 * the table also carries a BEFORE UPDATE OR DELETE OR TRUNCATE trigger that
 * raises. Triggers fire for the table owner as well, so nothing short of a
 * superuser running ALTER TABLE ... DISABLE TRIGGER can rewrite history — and
 * that is a deliberate, visible act rather than a stray query.
 */

exports.shorthands = undefined;

const RLS = (pgm, table) => {
  pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`CREATE POLICY tenant_isolation ON ${table}
             USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
             WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`);
};

/** Columns the application is allowed to write when voiding. */
const VOID_COLUMNS = 'voided_at, voided_by, void_reason';

const addVoidColumns = (pgm, table) => {
  pgm.addColumns(table, {
    voided_at: { type: 'timestamptz' },
    voided_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    void_reason: { type: 'text' },
  });

  // A void is a time, a person and a reason. Half a void is not a state this
  // table may hold: "voided, no reason given" is exactly the record someone
  // would leave behind on purpose.
  pgm.sql(`
    ALTER TABLE ${table} ADD CONSTRAINT ${table}_void_consistent
      CHECK (
        (voided_at IS NULL AND void_reason IS NULL)
        OR (voided_at IS NOT NULL AND btrim(coalesce(void_reason, '')) <> '')
      );
  `);
  pgm.createIndex(table, ['tenant_id', 'voided_at']);
};

exports.up = (pgm) => {
  const appUser = process.env.APP_DB_USER || 'app_user';

  /* ── 1. the clinic audit log ───────────────────────────────────────── */
  pgm.createTable('clinic_audit_log', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'CASCADE',
    },

    /**
     * The user is a reference for filtering, but the LABEL and ROLE are
     * snapshots taken at the moment of the action. A staff member who leaves
     * and is unlinked must not turn a year of history into "unknown", and a
     * receptionist later promoted must not retroactively appear to have been
     * the doctor when she took that payment.
     */
    actor_user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    actor_label: { type: 'text', notNull: true },
    actor_role: { type: 'text', notNull: true },

    action: { type: 'text', notNull: true },
    entity_type: { type: 'text', notNull: true },
    entity_id: { type: 'uuid' },

    /** One human-readable line, so the page reads without decoding metadata. */
    summary: { type: 'text', notNull: true },
    metadata: { type: 'jsonb', notNull: true, default: '{}' },

    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.sql(`ALTER TABLE clinic_audit_log ADD CONSTRAINT clinic_audit_summary_present
             CHECK (btrim(summary) <> '');`);

  pgm.createIndex('clinic_audit_log', ['tenant_id', 'created_at']);
  pgm.createIndex('clinic_audit_log', ['tenant_id', 'entity_type', 'entity_id']);
  pgm.createIndex('clinic_audit_log', ['tenant_id', 'actor_user_id', 'created_at']);
  pgm.createIndex('clinic_audit_log', ['tenant_id', 'action']);

  RLS(pgm, 'clinic_audit_log');

  // Append-only, twice over. First the privilege...
  pgm.sql(`REVOKE UPDATE, DELETE, TRUNCATE ON clinic_audit_log FROM ${appUser};`);

  // ...then the rule that survives someone granting it back.
  pgm.sql(`
    CREATE FUNCTION clinic_audit_log_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION
        'clinic_audit_log is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END $$;
  `);
  pgm.sql(`
    CREATE TRIGGER clinic_audit_log_no_rewrite
      BEFORE UPDATE OR DELETE ON clinic_audit_log
      FOR EACH ROW EXECUTE FUNCTION clinic_audit_log_append_only();
  `);
  pgm.sql(`
    CREATE TRIGGER clinic_audit_log_no_truncate
      BEFORE TRUNCATE ON clinic_audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION clinic_audit_log_append_only();
  `);

  /* ── 2. voidable money ─────────────────────────────────────────────── */
  addVoidColumns(pgm, 'payments');
  addVoidColumns(pgm, 'expenses');

  /* ── 3. take away the ability to destroy or rewrite it ─────────────── */
  pgm.sql(
    `REVOKE DELETE ON payments, invoices, expenses, ledger_entries FROM ${appUser};`,
  );

  // Narrow UPDATE to the void columns. Anything else about a recorded payment
  // — amount, method, date, who took it — is now immutable to the API.
  pgm.sql(`REVOKE UPDATE ON payments FROM ${appUser};`);
  pgm.sql(`GRANT UPDATE (${VOID_COLUMNS}) ON payments TO ${appUser};`);
  pgm.sql(`REVOKE UPDATE ON expenses FROM ${appUser};`);
  pgm.sql(`GRANT UPDATE (${VOID_COLUMNS}) ON expenses TO ${appUser};`);

  // 0016 described the ledger as append-only. Make it so.
  pgm.sql(`REVOKE UPDATE ON ledger_entries FROM ${appUser};`);
};

exports.down = (pgm) => {
  const appUser = process.env.APP_DB_USER || 'app_user';

  /* Refuse to throw away the record.
     -------------------------------------------------------------------------
     Everything else in this migration is ordinary and reversible. Dropping the
     table is not: it destroys the only account of who took, reversed or
     repriced what — and it would do it silently, as a side effect of a
     rollback aimed at something else entirely.

     So a rollback is allowed while the log is empty (a bad deploy, undone
     minutes later) and refused once anything has been recorded. Someone who
     genuinely means to discard it has to say so in as many words:

         DROP TRIGGER clinic_audit_log_no_rewrite ON clinic_audit_log;
         DROP TABLE clinic_audit_log;

     then run this again. That is two deliberate statements instead of one
     absent-minded `migrate down`. */
  pgm.sql(`
    DO $$
    DECLARE
      recorded bigint;
    BEGIN
      SELECT count(*) INTO recorded FROM clinic_audit_log;
      IF recorded > 0 THEN
        RAISE EXCEPTION
          'Migration 0018 rollback aborted: clinic_audit_log holds % recorded actions. Drop the trigger and the table by hand if you really mean to discard them.',
          recorded;
      END IF;
    END $$;
  `);

  // Restore the blanket grants first, or a rollback leaves the API unable to
  // record a payment against an invoice.
  pgm.sql(`GRANT UPDATE ON payments, expenses, ledger_entries TO ${appUser};`);
  pgm.sql(`GRANT DELETE ON payments, invoices, expenses, ledger_entries TO ${appUser};`);

  for (const table of ['payments', 'expenses']) {
    pgm.dropIndex(table, ['tenant_id', 'voided_at'], { ifExists: true });
    pgm.sql(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_void_consistent;`);
    pgm.dropColumns(table, ['voided_at', 'voided_by', 'void_reason']);
  }

  // The triggers refuse UPDATE and DELETE, not DROP TABLE.
  pgm.sql('DROP TRIGGER IF EXISTS clinic_audit_log_no_truncate ON clinic_audit_log;');
  pgm.sql('DROP TRIGGER IF EXISTS clinic_audit_log_no_rewrite ON clinic_audit_log;');
  pgm.dropTable('clinic_audit_log');
  pgm.sql('DROP FUNCTION IF EXISTS clinic_audit_log_append_only();');
};
