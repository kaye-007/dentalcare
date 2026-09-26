/**
 * 0001 — the baseline schema
 *
 * Generated, not written. This file is `pg_dump --schema-only --no-owner`
 * taken from a database built by migrations 0001..0021, which were then
 * deleted. Re-verify it at any time with:
 *
 *     node scripts/build-baseline.js --verify
 *
 * That script explains the three mechanical edits applied to the dump and
 * performs the check that makes this safe: build one database from the old
 * history, another from this file alone, dump both, and require the diff to
 * be empty. Not equivalent — identical.
 *
 * ── Upgrading a database that predates the squash ─────────────────────────
 *
 * A fresh database needs nothing special: `npm run migrate:up` builds the
 * schema from here.
 *
 * A database that already ran 0001..0021 needs one flag, once:
 *
 *     npm run migrate:up -- --no-check-order
 *
 * node-pg-migrate otherwise refuses, because `0001_baseline` sorts before
 * migrations it has already run — a sound default, and exactly the situation
 * a squash creates. With the flag, up() sees the schema is already present,
 * verifies that ALL 21 superseded migrations were applied,
 * converges the role, records itself and changes nothing else.
 *
 * A database that ran only SOME of them is refused outright, with the first
 * missing migration named. Recording the baseline against a half-built schema
 * would leave a database that reports itself current while missing tables,
 * and that is far worse than a failed command.
 *
 * ── What this file is responsible for ─────────────────────────────────────
 *
 * Everything below is load-bearing, and most of it is invisible in normal
 * operation, which is exactly why it is worth naming here. The tests that
 * prove each of these still hold live in apps/api/test/integration.
 *
 *   the app_user role       NOSUPERUSER, NOBYPASSRLS, converged rather than
 *                           created — see the block immediately below
 *
 *   RLS on every tenant     ENABLE *and* FORCE. Without FORCE the table owner
 *   table                   is exempt, and on a deployment where the API and
 *                           the migrations share a role that exemption is the
 *                           whole isolation model gone
 *
 *   tenant_isolation        one policy per tenant table, scoped by the
 *   policies                transaction-local GUC app.current_tenant_id
 *
 *   resolve_tenant()        SECURITY DEFINER, so the subdomain lookup can run
 *                           before any tenant context exists without exposing
 *                           other clinics. It is the one narrow window
 *                           app_user has onto `tenants` across the boundary
 *
 *   per-table grants        explicit, never GRANT ... ON ALL TABLES. The
 *                           difference is the entire money-immutability
 *                           story: payments and expenses carry column-level
 *                           UPDATE on the three void columns only, invoices
 *                           and ledger_entries have no DELETE, tenants has no
 *                           UPDATE beyond (name, updated_at), and plans and
 *                           pgmigrations have nothing
 *
 *   append-only triggers    clinic_audit_log refuses UPDATE, DELETE and
 *                           TRUNCATE. Triggers fire for the table owner too,
 *                           so nothing short of a superuser dropping them can
 *                           rewrite history — a deliberate, visible act
 *
 *   EXCLUDE constraints     double-booking a dentist, a chair or a patient is
 *                           impossible rather than unlikely. Evaluated by the
 *                           index at write time, so two people booking the
 *                           same slot in the same second cannot both win
 *
 * ── What is deliberately NOT here: ALTER DEFAULT PRIVILEGES ───────────────
 *
 * pg_dump emitted one more line than this file carries:
 *
 *     ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
 *       GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO app_user;
 *
 * It is removed, for two independent reasons, and build-baseline.js strips it
 * on every regeneration so it cannot come back.
 *
 *   1. It does not run anywhere but here. `--no-owner` strips ownership from
 *      tables but NOT the role name from a DEFAULT ACL, so the dump carried
 *      the developer's own role into the file. On any database whose owner is
 *      not called that — every managed Postgres there is — `migrate:up` fails
 *      with `role "..." does not exist` and rolls back to an empty database.
 *      CI could not see it either, because CI names its role the same way.
 *
 *   2. It is the fail-open direction. A default ACL grants app_user full DML
 *      on every table the owner creates in `public` FROM NOW ON — the blanket
 *      grant the per-table list above exists to replace, reinstated for
 *      tables that do not exist yet. A clinical table added next year would
 *      arrive writable before anyone decided it should be.
 *
 * Every table therefore states its own grants, and a new table is unreachable
 * by app_user until its migration says otherwise. That is the direction to
 * fail in.
 *
 * ── Rolling back ──────────────────────────────────────────────────────────
 *
 * There is no down migration. A baseline's inverse is an empty database, and
 * writing that as `DROP TABLE ...` invites someone to run it against one
 * with patients in it. Recreate the database instead.
 */

exports.shorthands = undefined;

/**
 * The migrations this file replaces.
 *
 * Kept so an existing database can adopt the baseline instead of being asked
 * to build a schema it already has. A database that has run all of these is
 * exactly the database this file produces, so the right thing there is to
 * record the baseline and change nothing.
 */
const SUPERSEDES = [
    "0001_init-extensions",
    "0002_tenants-users",
    "0003_tenant-isolation",
    "0004_platform",
    "0005_patients",
    "0006_appointments",
    "0007_treatments-medical-record",
    "0008_clinic-settings",
    "0009_finance",
    "0010_reminders",
    "0011_correction-pass",
    "0012_rbac-roles",
    "0013_patient-records",
    "0014_scheduling-engine",
    "0015_clinical-charting",
    "0016_billing-ledger",
    "0017_two-role-model",
    "0018_clinic-audit-and-voids",
    "0019_trials-and-mfa",
    "0020_google-oauth",
    "0021_tenant-commercial-state"
  ];

exports.up = async (pgm) => {
  const appUser = process.env.APP_DB_USER || 'app_user';
  const appPass = process.env.APP_DB_PASSWORD || 'app_user_dev_pw';

  const role = ROLE.replace(/__APP_USER__/g, appUser).replace(
    /__APP_PASSWORD__/g,
    appPass,
  );

  /* ── an existing database ─────────────────────────────────────────────
     A schema already built by 0001..0021 is identical to the one below —
     that equality is what build-baseline.js verifies, byte for byte — so
     running the DDL again would only fail on "relation already exists".

     Adopt it instead. The role convergence still runs, because it is
     idempotent and because a rebuilt database that kept a stale cluster-wide
     role is the exact failure 0003 existed to prevent.

     Partial history is refused rather than adopted: a database stopped
     halfway would otherwise record the baseline as applied and claim to be
     current while missing tables. */
  const built = await pgm.db.select(
    "SELECT to_regclass('public.tenants') IS NOT NULL AS present",
  );

  if (built[0] && built[0].present) {
    const applied = await pgm.db.select('SELECT name FROM pgmigrations');
    const have = new Set(applied.map((r) => r.name));
    const missing = SUPERSEDES.filter((name) => !have.has(name));

    if (missing.length > 0 && missing.length < SUPERSEDES.length) {
      throw new Error(
        `This database has a partial schema: ${missing.length} of the ` +
          `${SUPERSEDES.length} migrations this baseline replaces were never ` +
          `applied (first missing: ${missing[0]}).\n` +
          '  Bring it up to date from a checkout made before the squash, then ' +
          'run this again — or, if it holds no data you need, drop and ' +
          'recreate it.',
      );
    }

    pgm.sql(role);
    return;
  }

  pgm.sql(role);
  pgm.sql(SCHEMA.replace(/\bapp_user\b/g, appUser));
};

exports.down = () => {
  throw new Error(
    '0001_baseline has no down migration. Its inverse is an empty database — ' +
      'drop and recreate it instead.',
  );
};

const ROLE = `
-- ── the runtime role ──────────────────────────────────────────────────────
--
-- Converge, do not merely create.
--
-- A ROLE lives in the CLUSTER while a DATABASE does not, so dropping and
-- recreating the database leaves this role behind carrying whatever password
-- it was born with. An earlier version only ran CREATE when the role was
-- absent, so a rebuilt database inherited a stale password that no amount of
-- re-migrating could correct. The symptom was every authenticated request
-- returning 500, which looks nothing like a credentials problem and cost a
-- day to find.
--
-- NOBYPASSRLS is the load-bearing word. A role that can bypass row-level
-- security defeats every policy below it, including FORCE, and the API would
-- keep working perfectly while every clinic read every other clinic's data.
DO $do$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '__APP_USER__') THEN
      CREATE ROLE __APP_USER__ LOGIN PASSWORD '__APP_PASSWORD__'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    ELSE
      ALTER ROLE __APP_USER__ WITH LOGIN PASSWORD '__APP_PASSWORD__'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $do$;

DO $$
  BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '__APP_USER__');
  END $$;
`;

const SCHEMA = `
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';

--
-- Name: timerange; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.timerange AS RANGE (
    subtype = time without time zone,
    multirange_type_name = public.timemultirange
);

--
-- Name: clinic_audit_log_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.clinic_audit_log_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION
        'clinic_audit_log is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END $$;

--
-- Name: resolve_tenant(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_tenant(p_subdomain text) RETURNS TABLE(id uuid, status text, trial_ends_at timestamp with time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
               SELECT t.id, t.status, t.trial_ends_at
                 FROM tenants t
                WHERE t.subdomain = lower(p_subdomain)
                LIMIT 1;
             $$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: appointment_status_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointment_status_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    appointment_id uuid NOT NULL,
    from_status text,
    to_status text NOT NULL,
    note text,
    actor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT status_event_changes_something CHECK (((from_status IS NULL) OR (from_status <> to_status)))
);

ALTER TABLE ONLY public.appointment_status_events FORCE ROW LEVEL SECURITY;

--
-- Name: appointments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    staff_id uuid,
    reason text NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    operatory_id uuid,
    checked_in_at timestamp with time zone,
    in_progress_at timestamp with time zone,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    rescheduled_at timestamp with time zone,
    CONSTRAINT appointment_cancelled_consistent CHECK (((status = 'cancelled'::text) = (cancelled_at IS NOT NULL))),
    CONSTRAINT appointment_completed_consistent CHECK (((status = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT appointments_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'checked_in'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text, 'no_show'::text]))),
    CONSTRAINT appt_time_valid CHECK ((ends_at > starts_at))
);

ALTER TABLE ONLY public.appointments FORCE ROW LEVEL SECURITY;

--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_type text NOT NULL,
    actor_id uuid,
    actor_label text,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: clinic_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clinic_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    actor_user_id uuid,
    actor_label text NOT NULL,
    actor_role text NOT NULL,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid,
    summary text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clinic_audit_summary_present CHECK ((btrim(summary) <> ''::text))
);

ALTER TABLE ONLY public.clinic_audit_log FORCE ROW LEVEL SECURITY;

--
-- Name: clinic_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clinic_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    address text,
    city text,
    phone text,
    email text,
    working_hours jsonb DEFAULT '[]'::jsonb NOT NULL,
    default_appointment_duration integer DEFAULT 45 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reminders_enabled boolean DEFAULT false NOT NULL,
    reminder_hours_before integer DEFAULT 24 NOT NULL,
    payroll_logging_enabled boolean DEFAULT true NOT NULL,
    currency text DEFAULT 'EUR'::text NOT NULL,
    vat_rate_bp integer DEFAULT 0 NOT NULL,
    tax_number text,
    payment_terms_days integer DEFAULT 0 NOT NULL,
    CONSTRAINT cs_currency_valid CHECK ((currency = ANY (ARRAY['EUR'::text, 'ALL'::text, 'USD'::text, 'GBP'::text, 'CHF'::text]))),
    CONSTRAINT cs_payment_terms_valid CHECK (((payment_terms_days >= 0) AND (payment_terms_days <= 365))),
    CONSTRAINT cs_reminder_hours_valid CHECK (((reminder_hours_before >= 1) AND (reminder_hours_before <= 168))),
    CONSTRAINT cs_vat_rate_valid CHECK (((vat_rate_bp >= 0) AND (vat_rate_bp <= 10000)))
);

ALTER TABLE ONLY public.clinic_settings FORCE ROW LEVEL SECURITY;

--
-- Name: clinical_procedures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clinical_procedures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    tooth smallint,
    surfaces text[] DEFAULT '{}'::text[] NOT NULL,
    procedure_code_id uuid,
    diagnosis_code_id uuid,
    treatment_id uuid,
    plan_item_id uuid,
    appointment_id uuid,
    description text NOT NULL,
    clinician_id uuid,
    status text DEFAULT 'completed'::text NOT NULL,
    fee integer DEFAULT 0 NOT NULL,
    performed_on date DEFAULT CURRENT_DATE NOT NULL,
    note text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clinical_procedures_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text]))),
    CONSTRAINT procedure_description_present CHECK ((btrim(description) <> ''::text)),
    CONSTRAINT procedure_fee_sane CHECK ((fee >= 0)),
    CONSTRAINT procedure_surfaces_valid CHECK ((surfaces <@ ARRAY['M'::text, 'D'::text, 'O'::text, 'I'::text, 'F'::text, 'L'::text])),
    CONSTRAINT procedure_tooth_valid CHECK (((tooth IS NULL) OR (((tooth >= 11) AND (tooth <= 18)) OR ((tooth >= 21) AND (tooth <= 28)) OR ((tooth >= 31) AND (tooth <= 38)) OR ((tooth >= 41) AND (tooth <= 48)) OR ((tooth >= 51) AND (tooth <= 55)) OR ((tooth >= 61) AND (tooth <= 65)) OR ((tooth >= 71) AND (tooth <= 75)) OR ((tooth >= 81) AND (tooth <= 85)))))
);

ALTER TABLE ONLY public.clinical_procedures FORCE ROW LEVEL SECURITY;

--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    category text NOT NULL,
    amount integer NOT NULL,
    expense_date date DEFAULT CURRENT_DATE NOT NULL,
    note text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    voided_at timestamp with time zone,
    voided_by uuid,
    void_reason text,
    CONSTRAINT exp_amount_pos CHECK ((amount > 0)),
    CONSTRAINT expenses_category_check CHECK ((category = ANY (ARRAY['rent'::text, 'materials'::text, 'utilities'::text, 'salaries'::text, 'lab'::text, 'other'::text]))),
    CONSTRAINT expenses_void_consistent CHECK ((((voided_at IS NULL) AND (void_reason IS NULL)) OR ((voided_at IS NOT NULL) AND (btrim(COALESCE(void_reason, ''::text)) <> ''::text))))
);

ALTER TABLE ONLY public.expenses FORCE ROW LEVEL SECURITY;

--
-- Name: invoice_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_line_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    treatment_id uuid,
    description text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    unit_price integer DEFAULT 0 NOT NULL,
    amount integer DEFAULT 0 NOT NULL,
    discount_amount integer DEFAULT 0 NOT NULL,
    tax_rate_bp integer DEFAULT 0 NOT NULL,
    tax_amount integer DEFAULT 0 NOT NULL,
    plan_item_id uuid,
    procedure_id uuid,
    procedure_code_id uuid,
    tooth smallint,
    sort_order integer DEFAULT 0 NOT NULL,
    CONSTRAINT ili_amounts_sane CHECK (((unit_price >= 0) AND (amount >= 0) AND (discount_amount >= 0) AND (tax_amount >= 0))),
    CONSTRAINT ili_discount_bounded CHECK ((discount_amount <= (unit_price * quantity))),
    CONSTRAINT ili_qty_pos CHECK ((quantity > 0)),
    CONSTRAINT ili_tax_rate_valid CHECK (((tax_rate_bp >= 0) AND (tax_rate_bp <= 10000)))
);

ALTER TABLE ONLY public.invoice_line_items FORCE ROW LEVEL SECURITY;

--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    seq integer NOT NULL,
    invoice_number text NOT NULL,
    status text DEFAULT 'unpaid'::text NOT NULL,
    total integer DEFAULT 0 NOT NULL,
    issued_at date DEFAULT CURRENT_DATE NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    treatment_plan_id uuid,
    subtotal integer DEFAULT 0 NOT NULL,
    discount_amount integer DEFAULT 0 NOT NULL,
    tax_amount integer DEFAULT 0 NOT NULL,
    currency text DEFAULT 'EUR'::text NOT NULL,
    vat_rate_bp integer DEFAULT 0 NOT NULL,
    due_on date,
    notes text,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    CONSTRAINT invoice_amounts_sane CHECK (((subtotal >= 0) AND (discount_amount >= 0) AND (tax_amount >= 0) AND (total >= 0))),
    CONSTRAINT invoice_cancel_consistent CHECK (((status = 'cancelled'::text) = (cancelled_at IS NOT NULL))),
    CONSTRAINT invoice_currency_valid CHECK ((currency = ANY (ARRAY['EUR'::text, 'ALL'::text, 'USD'::text, 'GBP'::text, 'CHF'::text]))),
    CONSTRAINT invoices_status_check CHECK ((status = ANY (ARRAY['unpaid'::text, 'partially_paid'::text, 'paid'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.invoices FORCE ROW LEVEL SECURITY;

--
-- Name: ledger_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    invoice_id uuid,
    payment_id uuid,
    entry_type text NOT NULL,
    amount integer NOT NULL,
    currency text DEFAULT 'EUR'::text NOT NULL,
    description text NOT NULL,
    occurred_on date DEFAULT CURRENT_DATE NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_amount_nonzero CHECK ((amount <> 0)),
    CONSTRAINT ledger_currency_valid CHECK ((currency = ANY (ARRAY['EUR'::text, 'ALL'::text, 'USD'::text, 'GBP'::text, 'CHF'::text]))),
    CONSTRAINT ledger_description_present CHECK ((btrim(description) <> ''::text)),
    CONSTRAINT ledger_entries_entry_type_check CHECK ((entry_type = ANY (ARRAY['charge'::text, 'payment'::text, 'adjustment'::text, 'refund'::text, 'write_off'::text])))
);

ALTER TABLE ONLY public.ledger_entries FORCE ROW LEVEL SECURITY;

--
-- Name: operatories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operatories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    sort_order integer DEFAULT 0 NOT NULL,
    color text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operatory_color_hex CHECK (((color IS NULL) OR (color ~ '^#[0-9a-fA-F]{6}$'::text))),
    CONSTRAINT operatory_name_present CHECK ((btrim(name) <> ''::text))
);

ALTER TABLE ONLY public.operatories FORCE ROW LEVEL SECURITY;

--
-- Name: patient_allergies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_allergies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    substance text NOT NULL,
    reaction text,
    severity text DEFAULT 'moderate'::text NOT NULL,
    notes text,
    recorded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT allergy_substance_present CHECK ((btrim(substance) <> ''::text)),
    CONSTRAINT patient_allergies_severity_check CHECK ((severity = ANY (ARRAY['mild'::text, 'moderate'::text, 'severe'::text])))
);

ALTER TABLE ONLY public.patient_allergies FORCE ROW LEVEL SECURITY;

--
-- Name: patient_conditions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_conditions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    diagnosed_on date,
    notes text,
    recorded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT condition_name_present CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT patient_conditions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'resolved'::text])))
);

ALTER TABLE ONLY public.patient_conditions FORCE ROW LEVEL SECURITY;

--
-- Name: patient_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    storage_key text NOT NULL,
    file_name text NOT NULL,
    content_type text NOT NULL,
    byte_size bigint NOT NULL,
    checksum text NOT NULL,
    kind text DEFAULT 'other'::text NOT NULL,
    tooth smallint,
    taken_on date,
    caption text,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT document_delete_consistent CHECK (((deleted_at IS NULL) = (deleted_by IS NULL))),
    CONSTRAINT document_size_positive CHECK ((byte_size > 0)),
    CONSTRAINT document_tooth_fdi_valid CHECK (((tooth IS NULL) OR (((tooth >= 11) AND (tooth <= 18)) OR ((tooth >= 21) AND (tooth <= 28)) OR ((tooth >= 31) AND (tooth <= 38)) OR ((tooth >= 41) AND (tooth <= 48)) OR ((tooth >= 51) AND (tooth <= 55)) OR ((tooth >= 61) AND (tooth <= 65)) OR ((tooth >= 71) AND (tooth <= 75)) OR ((tooth >= 81) AND (tooth <= 85))))),
    CONSTRAINT patient_documents_kind_check CHECK ((kind = ANY (ARRAY['xray'::text, 'photo'::text, 'consent'::text, 'referral'::text, 'insurance'::text, 'report'::text, 'other'::text])))
);

ALTER TABLE ONLY public.patient_documents FORCE ROW LEVEL SECURITY;

--
-- Name: patient_medications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_medications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    name text NOT NULL,
    dosage text,
    frequency text,
    started_on date,
    ended_on date,
    notes text,
    recorded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT medication_dates_ordered CHECK (((ended_on IS NULL) OR (started_on IS NULL) OR (ended_on >= started_on))),
    CONSTRAINT medication_name_present CHECK ((btrim(name) <> ''::text))
);

ALTER TABLE ONLY public.patient_medications FORCE ROW LEVEL SECURITY;

--
-- Name: patient_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    body text NOT NULL,
    author_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.patient_notes FORCE ROW LEVEL SECURITY;

--
-- Name: patients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    phone text,
    email text,
    gender text,
    birth_date date,
    address text,
    city text,
    postal_code text,
    status text DEFAULT 'active'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    archived_by uuid,
    archive_reason text,
    emergency_contact_name text,
    emergency_contact_relationship text,
    emergency_contact_phone text,
    CONSTRAINT patients_archive_consistent CHECK ((((status = 'archived'::text) AND (archived_at IS NOT NULL)) OR ((status <> 'archived'::text) AND (archived_at IS NULL)))),
    CONSTRAINT patients_emergency_contact_usable CHECK (((emergency_contact_name IS NULL) OR (btrim(COALESCE(emergency_contact_phone, ''::text)) <> ''::text))),
    CONSTRAINT patients_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text]))),
    CONSTRAINT patients_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.patients FORCE ROW LEVEL SECURITY;

--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    amount integer NOT NULL,
    method text NOT NULL,
    note text,
    paid_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    reference text,
    voided_at timestamp with time zone,
    voided_by uuid,
    void_reason text,
    CONSTRAINT pay_amount_pos CHECK ((amount > 0)),
    CONSTRAINT payments_method_check CHECK ((method = ANY (ARRAY['cash'::text, 'card'::text, 'bank'::text]))),
    CONSTRAINT payments_void_consistent CHECK ((((voided_at IS NULL) AND (void_reason IS NULL)) OR ((voided_at IS NOT NULL) AND (btrim(COALESCE(void_reason, ''::text)) <> ''::text))))
);

ALTER TABLE ONLY public.payments FORCE ROW LEVEL SECURITY;

--
-- Name: perio_exams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.perio_exams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    examined_on date DEFAULT CURRENT_DATE NOT NULL,
    clinician_id uuid,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);

ALTER TABLE ONLY public.perio_exams FORCE ROW LEVEL SECURITY;

--
-- Name: perio_measurements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.perio_measurements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    exam_id uuid NOT NULL,
    tooth smallint NOT NULL,
    site text NOT NULL,
    probing_depth smallint,
    recession smallint,
    bleeding boolean DEFAULT false NOT NULL,
    suppuration boolean DEFAULT false NOT NULL,
    plaque boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT perio_depth_range CHECK (((probing_depth IS NULL) OR ((probing_depth >= 0) AND (probing_depth <= 15)))),
    CONSTRAINT perio_measurements_site_check CHECK ((site = ANY (ARRAY['MB'::text, 'B'::text, 'DB'::text, 'ML'::text, 'L'::text, 'DL'::text]))),
    CONSTRAINT perio_recession_range CHECK (((recession IS NULL) OR ((recession >= '-5'::integer) AND (recession <= 15)))),
    CONSTRAINT perio_tooth_valid CHECK ((((tooth >= 11) AND (tooth <= 18)) OR ((tooth >= 21) AND (tooth <= 28)) OR ((tooth >= 31) AND (tooth <= 38)) OR ((tooth >= 41) AND (tooth <= 48)) OR ((tooth >= 51) AND (tooth <= 55)) OR ((tooth >= 61) AND (tooth <= 65)) OR ((tooth >= 71) AND (tooth <= 75)) OR ((tooth >= 81) AND (tooth <= 85))))
);

ALTER TABLE ONLY public.perio_measurements FORCE ROW LEVEL SECURITY;

--
-- Name: perio_tooth_findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.perio_tooth_findings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    exam_id uuid NOT NULL,
    tooth smallint NOT NULL,
    mobility smallint,
    furcation smallint,
    note text,
    CONSTRAINT perio_findings_tooth_valid CHECK ((((tooth >= 11) AND (tooth <= 18)) OR ((tooth >= 21) AND (tooth <= 28)) OR ((tooth >= 31) AND (tooth <= 38)) OR ((tooth >= 41) AND (tooth <= 48)) OR ((tooth >= 51) AND (tooth <= 55)) OR ((tooth >= 61) AND (tooth <= 65)) OR ((tooth >= 71) AND (tooth <= 75)) OR ((tooth >= 81) AND (tooth <= 85)))),
    CONSTRAINT perio_furcation_range CHECK (((furcation IS NULL) OR ((furcation >= 0) AND (furcation <= 3)))),
    CONSTRAINT perio_mobility_range CHECK (((mobility IS NULL) OR ((mobility >= 0) AND (mobility <= 3))))
);

ALTER TABLE ONLY public.perio_tooth_findings FORCE ROW LEVEL SECURITY;

--
-- Name: plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    price_monthly integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: platform_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_admins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    full_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    totp_secret text,
    totp_enabled_at timestamp with time zone,
    google_sub text,
    google_linked_at timestamp with time zone,
    CONSTRAINT platform_admins_google_link_consistent CHECK (((google_sub IS NULL) = (google_linked_at IS NULL))),
    CONSTRAINT platform_admins_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
    CONSTRAINT platform_admins_totp_consistent CHECK (((totp_enabled_at IS NULL) OR (totp_secret IS NOT NULL)))
);

--
-- Name: procedure_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procedure_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    system text DEFAULT 'custom'::text NOT NULL,
    code text NOT NULL,
    description text NOT NULL,
    default_fee integer DEFAULT 0 NOT NULL,
    treatment_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_taxable boolean DEFAULT false NOT NULL,
    CONSTRAINT procedure_code_fee_sane CHECK ((default_fee >= 0)),
    CONSTRAINT procedure_code_present CHECK (((btrim(code) <> ''::text) AND (btrim(description) <> ''::text))),
    CONSTRAINT procedure_codes_system_check CHECK ((system = ANY (ARRAY['CDT'::text, 'ICD10'::text, 'custom'::text])))
);

ALTER TABLE ONLY public.procedure_codes FORCE ROW LEVEL SECURITY;

--
-- Name: reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    appointment_id uuid NOT NULL,
    type text NOT NULL,
    channel text DEFAULT 'log'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    message text NOT NULL,
    error text,
    sent_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reminders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text]))),
    CONSTRAINT reminders_type_check CHECK ((type = ANY (ARRAY['automatic'::text, 'manual'::text])))
);

ALTER TABLE ONLY public.reminders FORCE ROW LEVEL SECURITY;

--
-- Name: salary_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salary_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    staff_id uuid NOT NULL,
    "position" text,
    amount integer NOT NULL,
    paid_on date DEFAULT CURRENT_DATE NOT NULL,
    note text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sp_amount_pos CHECK ((amount > 0))
);

ALTER TABLE ONLY public.salary_payments FORCE ROW LEVEL SECURITY;

--
-- Name: staff_availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_availability (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    staff_id uuid NOT NULL,
    weekday smallint NOT NULL,
    starts_at time without time zone NOT NULL,
    ends_at time without time zone NOT NULL,
    operatory_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT availability_times_ordered CHECK ((ends_at > starts_at)),
    CONSTRAINT availability_weekday_valid CHECK (((weekday >= 0) AND (weekday <= 6)))
);

ALTER TABLE ONLY public.staff_availability FORCE ROW LEVEL SECURITY;

--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    subdomain text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    plan_id uuid,
    trial_ends_at timestamp with time zone,
    CONSTRAINT tenants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.tenants FORCE ROW LEVEL SECURITY;

--
-- Name: tooth_conditions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tooth_conditions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    tooth smallint NOT NULL,
    surface text,
    condition text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    note text,
    resolved_by_procedure_id uuid,
    dentist_id uuid,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tooth_conditions_condition_check CHECK ((condition = ANY (ARRAY['caries'::text, 'restored'::text, 'crown'::text, 'bridge'::text, 'veneer'::text, 'root_canal'::text, 'implant'::text, 'extracted'::text, 'missing'::text, 'impacted'::text, 'fractured'::text, 'sealant'::text, 'watch'::text]))),
    CONSTRAINT tooth_conditions_fdi_valid CHECK ((((tooth >= 11) AND (tooth <= 18)) OR ((tooth >= 21) AND (tooth <= 28)) OR ((tooth >= 31) AND (tooth <= 38)) OR ((tooth >= 41) AND (tooth <= 48)) OR ((tooth >= 51) AND (tooth <= 55)) OR ((tooth >= 61) AND (tooth <= 65)) OR ((tooth >= 71) AND (tooth <= 75)) OR ((tooth >= 81) AND (tooth <= 85)))),
    CONSTRAINT tooth_conditions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'treated'::text, 'resolved'::text]))),
    CONSTRAINT tooth_conditions_surface_anatomical CHECK (((surface IS NULL) OR ((surface = 'O'::text) AND (((tooth)::integer % 10) >= 4)) OR ((surface = 'I'::text) AND (((tooth)::integer % 10) <= 3)) OR (surface = ANY (ARRAY['M'::text, 'D'::text, 'F'::text, 'L'::text])))),
    CONSTRAINT tooth_conditions_surface_check CHECK ((surface = ANY (ARRAY['M'::text, 'D'::text, 'O'::text, 'I'::text, 'F'::text, 'L'::text]))),
    CONSTRAINT tooth_conditions_whole_tooth CHECK (((condition <> ALL (ARRAY['extracted'::text, 'missing'::text, 'implant'::text, 'impacted'::text, 'crown'::text, 'bridge'::text, 'root_canal'::text])) OR (surface IS NULL)))
);

ALTER TABLE ONLY public.tooth_conditions FORCE ROW LEVEL SECURITY;

--
-- Name: treatment_plan_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.treatment_plan_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    tooth smallint,
    surfaces text[] DEFAULT '{}'::text[] NOT NULL,
    procedure_code_id uuid,
    treatment_id uuid,
    description text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    unit_fee integer DEFAULT 0 NOT NULL,
    discount_amount integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'planned'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plan_item_description_present CHECK ((btrim(description) <> ''::text)),
    CONSTRAINT plan_item_discount_bounded CHECK ((discount_amount <= (unit_fee * quantity))),
    CONSTRAINT plan_item_fee_sane CHECK (((unit_fee >= 0) AND (discount_amount >= 0))),
    CONSTRAINT plan_item_quantity_positive CHECK ((quantity > 0)),
    CONSTRAINT plan_item_surfaces_valid CHECK ((surfaces <@ ARRAY['M'::text, 'D'::text, 'O'::text, 'I'::text, 'F'::text, 'L'::text])),
    CONSTRAINT plan_item_tooth_valid CHECK (((tooth IS NULL) OR (((tooth >= 11) AND (tooth <= 18)) OR ((tooth >= 21) AND (tooth <= 28)) OR ((tooth >= 31) AND (tooth <= 38)) OR ((tooth >= 41) AND (tooth <= 48)) OR ((tooth >= 51) AND (tooth <= 55)) OR ((tooth >= 61) AND (tooth <= 65)) OR ((tooth >= 71) AND (tooth <= 75)) OR ((tooth >= 81) AND (tooth <= 85))))),
    CONSTRAINT treatment_plan_items_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'scheduled'::text, 'completed'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.treatment_plan_items FORCE ROW LEVEL SECURITY;

--
-- Name: treatment_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.treatment_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    patient_id uuid NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    note text,
    discount_amount integer DEFAULT 0 NOT NULL,
    proposed_at timestamp with time zone,
    accepted_at timestamp with time zone,
    declined_at timestamp with time zone,
    decline_reason text,
    completed_at timestamp with time zone,
    dentist_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plan_accepted_consistent CHECK (((status = 'accepted'::text) <= (accepted_at IS NOT NULL))),
    CONSTRAINT plan_declined_consistent CHECK (((status = 'declined'::text) = (declined_at IS NOT NULL))),
    CONSTRAINT plan_discount_sane CHECK ((discount_amount >= 0)),
    CONSTRAINT plan_title_present CHECK ((btrim(title) <> ''::text)),
    CONSTRAINT treatment_plans_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'proposed'::text, 'accepted'::text, 'in_progress'::text, 'completed'::text, 'declined'::text])))
);

ALTER TABLE ONLY public.treatment_plans FORCE ROW LEVEL SECURITY;

--
-- Name: treatments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.treatments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    price integer DEFAULT 0 NOT NULL,
    duration_minutes integer DEFAULT 60 NOT NULL,
    visit_type text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_taxable boolean DEFAULT false NOT NULL,
    CONSTRAINT treatments_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text]))),
    CONSTRAINT treatments_visit_type_check CHECK ((visit_type = ANY (ARRAY['single'::text, 'multiple'::text])))
);

ALTER TABLE ONLY public.treatments FORCE ROW LEVEL SECURITY;

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    full_name text NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    "position" text,
    salary_amount integer,
    salary_note text,
    totp_secret text,
    totp_enabled_at timestamp with time zone,
    google_sub text,
    google_linked_at timestamp with time zone,
    CONSTRAINT users_google_link_consistent CHECK (((google_sub IS NULL) = (google_linked_at IS NULL))),
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'receptionist'::text]))),
    CONSTRAINT users_salary_positive CHECK (((salary_amount IS NULL) OR (salary_amount > 0))),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
    CONSTRAINT users_totp_consistent CHECK (((totp_enabled_at IS NULL) OR (totp_secret IS NOT NULL)))
);

ALTER TABLE ONLY public.users FORCE ROW LEVEL SECURITY;

--
-- Name: appointments appointment_no_operatory_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointment_no_operatory_overlap EXCLUDE USING gist (operatory_id WITH =, tstzrange(starts_at, ends_at, '[)'::text) WITH &&) WHERE (((operatory_id IS NOT NULL) AND (status = ANY (ARRAY['scheduled'::text, 'checked_in'::text, 'in_progress'::text]))));

--
-- Name: appointments appointment_no_patient_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointment_no_patient_overlap EXCLUDE USING gist (patient_id WITH =, tstzrange(starts_at, ends_at, '[)'::text) WITH &&) WHERE ((status = ANY (ARRAY['scheduled'::text, 'checked_in'::text, 'in_progress'::text])));

--
-- Name: appointments appointment_no_staff_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointment_no_staff_overlap EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at, '[)'::text) WITH &&) WHERE (((staff_id IS NOT NULL) AND (status = ANY (ARRAY['scheduled'::text, 'checked_in'::text, 'in_progress'::text]))));

--
-- Name: appointment_status_events appointment_status_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_status_events
    ADD CONSTRAINT appointment_status_events_pkey PRIMARY KEY (id);

--
-- Name: appointments appointments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_pkey PRIMARY KEY (id);

--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

--
-- Name: staff_availability availability_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_availability
    ADD CONSTRAINT availability_no_overlap EXCLUDE USING gist (staff_id WITH =, weekday WITH =, public.timerange(starts_at, ends_at, '[)'::text) WITH &&);

--
-- Name: clinic_audit_log clinic_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinic_audit_log
    ADD CONSTRAINT clinic_audit_log_pkey PRIMARY KEY (id);

--
-- Name: clinic_settings clinic_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinic_settings
    ADD CONSTRAINT clinic_settings_pkey PRIMARY KEY (id);

--
-- Name: clinic_settings clinic_settings_tenant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinic_settings
    ADD CONSTRAINT clinic_settings_tenant_id_key UNIQUE (tenant_id);

--
-- Name: clinical_procedures clinical_procedures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_procedures
    ADD CONSTRAINT clinical_procedures_pkey PRIMARY KEY (id);

--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);

--
-- Name: invoice_line_items invoice_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_pkey PRIMARY KEY (id);

--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);

--
-- Name: ledger_entries ledger_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_pkey PRIMARY KEY (id);

--
-- Name: operatories operatories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operatories
    ADD CONSTRAINT operatories_pkey PRIMARY KEY (id);

--
-- Name: patient_allergies patient_allergies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_allergies
    ADD CONSTRAINT patient_allergies_pkey PRIMARY KEY (id);

--
-- Name: patient_conditions patient_conditions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_conditions
    ADD CONSTRAINT patient_conditions_pkey PRIMARY KEY (id);

--
-- Name: patient_documents patient_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_documents
    ADD CONSTRAINT patient_documents_pkey PRIMARY KEY (id);

--
-- Name: patient_medications patient_medications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_medications
    ADD CONSTRAINT patient_medications_pkey PRIMARY KEY (id);

--
-- Name: patient_notes patient_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_notes
    ADD CONSTRAINT patient_notes_pkey PRIMARY KEY (id);

--
-- Name: patients patients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_pkey PRIMARY KEY (id);

--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

--
-- Name: perio_exams perio_exams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perio_exams
    ADD CONSTRAINT perio_exams_pkey PRIMARY KEY (id);

--
-- Name: perio_measurements perio_measurements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perio_measurements
    ADD CONSTRAINT perio_measurements_pkey PRIMARY KEY (id);

--
-- Name: perio_tooth_findings perio_tooth_findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perio_tooth_findings
    ADD CONSTRAINT perio_tooth_findings_pkey PRIMARY KEY (id);

--
-- Name: plans plans_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_code_key UNIQUE (code);

--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);

--
-- Name: platform_admins platform_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_pkey PRIMARY KEY (id);

--
-- Name: procedure_codes procedure_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procedure_codes
    ADD CONSTRAINT procedure_codes_pkey PRIMARY KEY (id);

--
-- Name: reminders reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_pkey PRIMARY KEY (id);

--
-- Name: salary_payments salary_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_pkey PRIMARY KEY (id);

--
-- Name: staff_availability staff_availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_availability
    ADD CONSTRAINT staff_availability_pkey PRIMARY KEY (id);

--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

--
-- Name: tenants tenants_subdomain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_subdomain_key UNIQUE (subdomain);

--
-- Name: tooth_conditions tooth_conditions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooth_conditions
    ADD CONSTRAINT tooth_conditions_pkey PRIMARY KEY (id);

--
-- Name: treatment_plan_items treatment_plan_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plan_items
    ADD CONSTRAINT treatment_plan_items_pkey PRIMARY KEY (id);

--
-- Name: treatment_plans treatment_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plans
    ADD CONSTRAINT treatment_plans_pkey PRIMARY KEY (id);

--
-- Name: treatments treatments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatments
    ADD CONSTRAINT treatments_pkey PRIMARY KEY (id);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: appointment_status_events_appointment_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointment_status_events_appointment_id_created_at_index ON public.appointment_status_events USING btree (appointment_id, created_at);

--
-- Name: appointment_status_events_tenant_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointment_status_events_tenant_id_created_at_index ON public.appointment_status_events USING btree (tenant_id, created_at);

--
-- Name: appointments_tenant_id_operatory_id_starts_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointments_tenant_id_operatory_id_starts_at_index ON public.appointments USING btree (tenant_id, operatory_id, starts_at);

--
-- Name: appointments_tenant_id_patient_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointments_tenant_id_patient_id_index ON public.appointments USING btree (tenant_id, patient_id);

--
-- Name: appointments_tenant_id_staff_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointments_tenant_id_staff_id_index ON public.appointments USING btree (tenant_id, staff_id);

--
-- Name: appointments_tenant_id_starts_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointments_tenant_id_starts_at_index ON public.appointments USING btree (tenant_id, starts_at);

--
-- Name: appointments_tenant_id_status_starts_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointments_tenant_id_status_starts_at_index ON public.appointments USING btree (tenant_id, status, starts_at);

--
-- Name: audit_log_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_created_at_index ON public.audit_log USING btree (created_at);

--
-- Name: audit_log_entity_type_entity_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_entity_type_entity_id_index ON public.audit_log USING btree (entity_type, entity_id);

--
-- Name: clinic_audit_log_tenant_id_action_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clinic_audit_log_tenant_id_action_index ON public.clinic_audit_log USING btree (tenant_id, action);

--
-- Name: clinic_audit_log_tenant_id_actor_user_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clinic_audit_log_tenant_id_actor_user_id_created_at_index ON public.clinic_audit_log USING btree (tenant_id, actor_user_id, created_at);

--
-- Name: clinic_audit_log_tenant_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clinic_audit_log_tenant_id_created_at_index ON public.clinic_audit_log USING btree (tenant_id, created_at);

--
-- Name: clinic_audit_log_tenant_id_entity_type_entity_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clinic_audit_log_tenant_id_entity_type_entity_id_index ON public.clinic_audit_log USING btree (tenant_id, entity_type, entity_id);

--
-- Name: clinical_procedures_tenant_id_clinician_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clinical_procedures_tenant_id_clinician_id_index ON public.clinical_procedures USING btree (tenant_id, clinician_id);

--
-- Name: clinical_procedures_tenant_id_patient_id_performed_on_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clinical_procedures_tenant_id_patient_id_performed_on_index ON public.clinical_procedures USING btree (tenant_id, patient_id, performed_on);

--
-- Name: expenses_tenant_id_expense_date_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_tenant_id_expense_date_index ON public.expenses USING btree (tenant_id, expense_date);

--
-- Name: expenses_tenant_id_voided_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_tenant_id_voided_at_index ON public.expenses USING btree (tenant_id, voided_at);

--
-- Name: invoice_line_items_invoice_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoice_line_items_invoice_id_index ON public.invoice_line_items USING btree (invoice_id);

--
-- Name: invoice_line_plan_item_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invoice_line_plan_item_unique ON public.invoice_line_items USING btree (plan_item_id) WHERE (plan_item_id IS NOT NULL);

--
-- Name: invoices_tenant_id_issued_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_tenant_id_issued_at_index ON public.invoices USING btree (tenant_id, issued_at);

--
-- Name: invoices_tenant_id_patient_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_tenant_id_patient_id_index ON public.invoices USING btree (tenant_id, patient_id);

--
-- Name: invoices_tenant_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_tenant_id_status_index ON public.invoices USING btree (tenant_id, status);

--
-- Name: invoices_tenant_id_treatment_plan_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_tenant_id_treatment_plan_id_index ON public.invoices USING btree (tenant_id, treatment_plan_id);

--
-- Name: invoices_tenant_seq_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invoices_tenant_seq_unique ON public.invoices USING btree (tenant_id, seq);

--
-- Name: ledger_entries_invoice_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_invoice_id_index ON public.ledger_entries USING btree (invoice_id);

--
-- Name: ledger_entries_tenant_id_occurred_on_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_tenant_id_occurred_on_index ON public.ledger_entries USING btree (tenant_id, occurred_on);

--
-- Name: ledger_entries_tenant_id_patient_id_occurred_on_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ledger_entries_tenant_id_patient_id_occurred_on_index ON public.ledger_entries USING btree (tenant_id, patient_id, occurred_on);

--
-- Name: operatories_tenant_id_sort_order_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operatories_tenant_id_sort_order_index ON public.operatories USING btree (tenant_id, sort_order);

--
-- Name: operatories_tenant_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operatories_tenant_name_unique ON public.operatories USING btree (tenant_id, lower(btrim(name)));

--
-- Name: patient_allergies_tenant_id_patient_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_allergies_tenant_id_patient_id_index ON public.patient_allergies USING btree (tenant_id, patient_id);

--
-- Name: patient_allergy_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patient_allergy_unique ON public.patient_allergies USING btree (patient_id, lower(btrim(substance)));

--
-- Name: patient_conditions_tenant_id_patient_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_conditions_tenant_id_patient_id_index ON public.patient_conditions USING btree (tenant_id, patient_id);

--
-- Name: patient_documents_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_documents_live_idx ON public.patient_documents USING btree (patient_id, created_at DESC) WHERE (deleted_at IS NULL);

--
-- Name: patient_documents_storage_key_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patient_documents_storage_key_unique ON public.patient_documents USING btree (storage_key);

--
-- Name: patient_documents_tenant_id_patient_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_documents_tenant_id_patient_id_index ON public.patient_documents USING btree (tenant_id, patient_id);

--
-- Name: patient_medications_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_medications_current_idx ON public.patient_medications USING btree (patient_id) WHERE (ended_on IS NULL);

--
-- Name: patient_medications_tenant_id_patient_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_medications_tenant_id_patient_id_index ON public.patient_medications USING btree (tenant_id, patient_id);

--
-- Name: patient_notes_patient_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_notes_patient_id_index ON public.patient_notes USING btree (patient_id);

--
-- Name: patient_notes_tenant_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_notes_tenant_id_index ON public.patient_notes USING btree (tenant_id);

--
-- Name: patients_tenant_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_tenant_id_index ON public.patients USING btree (tenant_id);

--
-- Name: patients_tenant_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_tenant_id_status_index ON public.patients USING btree (tenant_id, status);

--
-- Name: payments_invoice_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payments_invoice_id_index ON public.payments USING btree (invoice_id);

--
-- Name: payments_tenant_id_paid_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payments_tenant_id_paid_at_index ON public.payments USING btree (tenant_id, paid_at);

--
-- Name: payments_tenant_id_voided_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payments_tenant_id_voided_at_index ON public.payments USING btree (tenant_id, voided_at);

--
-- Name: perio_exams_tenant_id_patient_id_examined_on_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX perio_exams_tenant_id_patient_id_examined_on_index ON public.perio_exams USING btree (tenant_id, patient_id, examined_on);

--
-- Name: perio_measurement_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX perio_measurement_unique ON public.perio_measurements USING btree (exam_id, tooth, site);

--
-- Name: perio_measurements_tenant_id_exam_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX perio_measurements_tenant_id_exam_id_index ON public.perio_measurements USING btree (tenant_id, exam_id);

--
-- Name: perio_tooth_finding_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX perio_tooth_finding_unique ON public.perio_tooth_findings USING btree (exam_id, tooth);

--
-- Name: platform_admins_email_lower_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX platform_admins_email_lower_unique ON public.platform_admins USING btree (lower(email));

--
-- Name: platform_admins_google_sub_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX platform_admins_google_sub_unique ON public.platform_admins USING btree (google_sub) WHERE (google_sub IS NOT NULL);

--
-- Name: procedure_codes_tenant_id_is_active_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX procedure_codes_tenant_id_is_active_index ON public.procedure_codes USING btree (tenant_id, is_active);

--
-- Name: procedure_codes_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX procedure_codes_unique ON public.procedure_codes USING btree (tenant_id, system, upper(btrim(code)));

--
-- Name: reminders_appointment_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_appointment_id_index ON public.reminders USING btree (appointment_id);

--
-- Name: reminders_auto_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX reminders_auto_unique ON public.reminders USING btree (appointment_id) WHERE (type = 'automatic'::text);

--
-- Name: reminders_tenant_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_tenant_id_created_at_index ON public.reminders USING btree (tenant_id, created_at);

--
-- Name: salary_payments_tenant_id_paid_on_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salary_payments_tenant_id_paid_on_index ON public.salary_payments USING btree (tenant_id, paid_on);

--
-- Name: staff_availability_tenant_id_staff_id_weekday_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_availability_tenant_id_staff_id_weekday_index ON public.staff_availability USING btree (tenant_id, staff_id, weekday);

--
-- Name: tenants_trial_ends_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tenants_trial_ends_at_idx ON public.tenants USING btree (trial_ends_at) WHERE (trial_ends_at IS NOT NULL);

--
-- Name: tooth_conditions_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tooth_conditions_active_unique ON public.tooth_conditions USING btree (patient_id, tooth, COALESCE(surface, '*'::text), condition) WHERE (status = 'active'::text);

--
-- Name: tooth_conditions_tenant_id_patient_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tooth_conditions_tenant_id_patient_id_index ON public.tooth_conditions USING btree (tenant_id, patient_id);

--
-- Name: tooth_conditions_tenant_id_patient_id_tooth_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tooth_conditions_tenant_id_patient_id_tooth_index ON public.tooth_conditions USING btree (tenant_id, patient_id, tooth);

--
-- Name: treatment_plan_items_tenant_id_plan_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX treatment_plan_items_tenant_id_plan_id_index ON public.treatment_plan_items USING btree (tenant_id, plan_id);

--
-- Name: treatment_plans_tenant_id_patient_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX treatment_plans_tenant_id_patient_id_status_index ON public.treatment_plans USING btree (tenant_id, patient_id, status);

--
-- Name: treatments_tenant_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX treatments_tenant_id_status_index ON public.treatments USING btree (tenant_id, status);

--
-- Name: treatments_tenant_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX treatments_tenant_name_unique ON public.treatments USING btree (tenant_id, lower(name));

--
-- Name: users_tenant_email_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_tenant_email_unique ON public.users USING btree (tenant_id, lower(email));

--
-- Name: users_tenant_google_sub_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_tenant_google_sub_unique ON public.users USING btree (tenant_id, google_sub) WHERE (google_sub IS NOT NULL);

--
-- Name: users_tenant_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_tenant_id_index ON public.users USING btree (tenant_id);

--
-- Name: users_tenant_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_tenant_role_idx ON public.users USING btree (tenant_id, role);

--
-- Name: clinic_audit_log clinic_audit_log_no_rewrite; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clinic_audit_log_no_rewrite BEFORE DELETE OR UPDATE ON public.clinic_audit_log FOR EACH ROW EXECUTE FUNCTION public.clinic_audit_log_append_only();

--
-- Name: clinic_audit_log clinic_audit_log_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clinic_audit_log_no_truncate BEFORE TRUNCATE ON public.clinic_audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.clinic_audit_log_append_only();

--
-- Name: appointment_status_events appointment_status_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_status_events
    ADD CONSTRAINT appointment_status_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: appointment_status_events appointment_status_events_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_status_events
    ADD CONSTRAINT appointment_status_events_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE CASCADE;

--
-- Name: appointment_status_events appointment_status_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_status_events
    ADD CONSTRAINT appointment_status_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: appointments appointments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: appointments appointments_operatory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_operatory_id_fkey FOREIGN KEY (operatory_id) REFERENCES public.operatories(id) ON DELETE SET NULL;

--
-- Name: appointments appointments_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: appointments appointments_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: appointments appointments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: clinic_audit_log clinic_audit_log_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinic_audit_log
    ADD CONSTRAINT clinic_audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: clinic_audit_log clinic_audit_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinic_audit_log
    ADD CONSTRAINT clinic_audit_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: clinic_settings clinic_settings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinic_settings
    ADD CONSTRAINT clinic_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: clinical_procedures clinical_procedures_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_procedures
    ADD CONSTRAINT clinical_procedures_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE SET NULL;

--
-- Name: clinical_procedures clinical_procedures_clinician_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_procedures
    ADD CONSTRAINT clinical_procedures_clinician_id_fkey FOREIGN KEY (clinician_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: clinical_procedures clinical_procedures_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_procedures
    ADD CONSTRAINT clinical_procedures_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: clinical_procedures clinical_procedures_diagnosis_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_procedures
    ADD CONSTRAINT clinical_procedures_diagnosis_code_id_fkey FOREIGN KEY (diagnosis_code_id) REFERENCES public.procedure_codes(id) ON DELETE SET NULL;

--
-- Name: clinical_procedures clinical_procedures_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_procedures
    ADD CONSTRAINT clinical_procedures_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: clinical_procedures clinical_procedures_plan_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_procedures
    ADD CONSTRAINT clinical_procedures_plan_item_id_fkey FOREIGN KEY (plan_item_id) REFERENCES public.treatment_plan_items(id) ON DELETE SET NULL;

--
-- Name: clinical_procedures clinical_procedures_procedure_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_procedures
    ADD CONSTRAINT clinical_procedures_procedure_code_id_fkey FOREIGN KEY (procedure_code_id) REFERENCES public.procedure_codes(id) ON DELETE SET NULL;

--
-- Name: clinical_procedures clinical_procedures_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_procedures
    ADD CONSTRAINT clinical_procedures_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: clinical_procedures clinical_procedures_treatment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_procedures
    ADD CONSTRAINT clinical_procedures_treatment_id_fkey FOREIGN KEY (treatment_id) REFERENCES public.treatments(id) ON DELETE SET NULL;

--
-- Name: expenses expenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: expenses expenses_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: expenses expenses_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: invoice_line_items invoice_line_items_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;

--
-- Name: invoice_line_items invoice_line_items_plan_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_plan_item_id_fkey FOREIGN KEY (plan_item_id) REFERENCES public.treatment_plan_items(id) ON DELETE SET NULL;

--
-- Name: invoice_line_items invoice_line_items_procedure_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_procedure_code_id_fkey FOREIGN KEY (procedure_code_id) REFERENCES public.procedure_codes(id) ON DELETE SET NULL;

--
-- Name: invoice_line_items invoice_line_items_procedure_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_procedure_id_fkey FOREIGN KEY (procedure_id) REFERENCES public.clinical_procedures(id) ON DELETE SET NULL;

--
-- Name: invoice_line_items invoice_line_items_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: invoice_line_items invoice_line_items_treatment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_treatment_id_fkey FOREIGN KEY (treatment_id) REFERENCES public.treatments(id) ON DELETE SET NULL;

--
-- Name: invoices invoices_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: invoices invoices_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: invoices invoices_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: invoices invoices_treatment_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_treatment_plan_id_fkey FOREIGN KEY (treatment_plan_id) REFERENCES public.treatment_plans(id) ON DELETE SET NULL;

--
-- Name: ledger_entries ledger_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: ledger_entries ledger_entries_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE SET NULL;

--
-- Name: ledger_entries ledger_entries_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: ledger_entries ledger_entries_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE SET NULL;

--
-- Name: ledger_entries ledger_entries_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: operatories operatories_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operatories
    ADD CONSTRAINT operatories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: patient_allergies patient_allergies_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_allergies
    ADD CONSTRAINT patient_allergies_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: patient_allergies patient_allergies_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_allergies
    ADD CONSTRAINT patient_allergies_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: patient_allergies patient_allergies_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_allergies
    ADD CONSTRAINT patient_allergies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: patient_conditions patient_conditions_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_conditions
    ADD CONSTRAINT patient_conditions_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: patient_conditions patient_conditions_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_conditions
    ADD CONSTRAINT patient_conditions_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: patient_conditions patient_conditions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_conditions
    ADD CONSTRAINT patient_conditions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: patient_documents patient_documents_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_documents
    ADD CONSTRAINT patient_documents_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: patient_documents patient_documents_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_documents
    ADD CONSTRAINT patient_documents_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: patient_documents patient_documents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_documents
    ADD CONSTRAINT patient_documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: patient_documents patient_documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_documents
    ADD CONSTRAINT patient_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: patient_medications patient_medications_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_medications
    ADD CONSTRAINT patient_medications_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: patient_medications patient_medications_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_medications
    ADD CONSTRAINT patient_medications_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: patient_medications patient_medications_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_medications
    ADD CONSTRAINT patient_medications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: patient_notes patient_notes_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_notes
    ADD CONSTRAINT patient_notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: patient_notes patient_notes_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_notes
    ADD CONSTRAINT patient_notes_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: patient_notes patient_notes_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_notes
    ADD CONSTRAINT patient_notes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: patients patients_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: patients patients_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: patients patients_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: payments payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: payments payments_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;

--
-- Name: payments payments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: payments payments_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: perio_exams perio_exams_clinician_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perio_exams
    ADD CONSTRAINT perio_exams_clinician_id_fkey FOREIGN KEY (clinician_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: perio_exams perio_exams_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perio_exams
    ADD CONSTRAINT perio_exams_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: perio_exams perio_exams_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perio_exams
    ADD CONSTRAINT perio_exams_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: perio_exams perio_exams_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perio_exams
    ADD CONSTRAINT perio_exams_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: perio_measurements perio_measurements_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perio_measurements
    ADD CONSTRAINT perio_measurements_exam_id_fkey FOREIGN KEY (exam_id) REFERENCES public.perio_exams(id) ON DELETE CASCADE;

--
-- Name: perio_measurements perio_measurements_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perio_measurements
    ADD CONSTRAINT perio_measurements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: perio_tooth_findings perio_tooth_findings_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perio_tooth_findings
    ADD CONSTRAINT perio_tooth_findings_exam_id_fkey FOREIGN KEY (exam_id) REFERENCES public.perio_exams(id) ON DELETE CASCADE;

--
-- Name: perio_tooth_findings perio_tooth_findings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perio_tooth_findings
    ADD CONSTRAINT perio_tooth_findings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: procedure_codes procedure_codes_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procedure_codes
    ADD CONSTRAINT procedure_codes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: procedure_codes procedure_codes_treatment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procedure_codes
    ADD CONSTRAINT procedure_codes_treatment_id_fkey FOREIGN KEY (treatment_id) REFERENCES public.treatments(id) ON DELETE SET NULL;

--
-- Name: reminders reminders_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE CASCADE;

--
-- Name: reminders reminders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: reminders reminders_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: salary_payments salary_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: salary_payments salary_payments_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: salary_payments salary_payments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_payments
    ADD CONSTRAINT salary_payments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: staff_availability staff_availability_operatory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_availability
    ADD CONSTRAINT staff_availability_operatory_id_fkey FOREIGN KEY (operatory_id) REFERENCES public.operatories(id) ON DELETE SET NULL;

--
-- Name: staff_availability staff_availability_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_availability
    ADD CONSTRAINT staff_availability_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: staff_availability staff_availability_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_availability
    ADD CONSTRAINT staff_availability_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: tenants tenants_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;

--
-- Name: tooth_conditions tooth_conditions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooth_conditions
    ADD CONSTRAINT tooth_conditions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: tooth_conditions tooth_conditions_dentist_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooth_conditions
    ADD CONSTRAINT tooth_conditions_dentist_id_fkey FOREIGN KEY (dentist_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: tooth_conditions tooth_conditions_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooth_conditions
    ADD CONSTRAINT tooth_conditions_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: tooth_conditions tooth_conditions_resolved_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooth_conditions
    ADD CONSTRAINT tooth_conditions_resolved_by_fk FOREIGN KEY (resolved_by_procedure_id) REFERENCES public.clinical_procedures(id) ON DELETE SET NULL;

--
-- Name: tooth_conditions tooth_conditions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooth_conditions
    ADD CONSTRAINT tooth_conditions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: treatment_plan_items treatment_plan_items_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plan_items
    ADD CONSTRAINT treatment_plan_items_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.treatment_plans(id) ON DELETE CASCADE;

--
-- Name: treatment_plan_items treatment_plan_items_procedure_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plan_items
    ADD CONSTRAINT treatment_plan_items_procedure_code_id_fkey FOREIGN KEY (procedure_code_id) REFERENCES public.procedure_codes(id) ON DELETE SET NULL;

--
-- Name: treatment_plan_items treatment_plan_items_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plan_items
    ADD CONSTRAINT treatment_plan_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: treatment_plan_items treatment_plan_items_treatment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plan_items
    ADD CONSTRAINT treatment_plan_items_treatment_id_fkey FOREIGN KEY (treatment_id) REFERENCES public.treatments(id) ON DELETE SET NULL;

--
-- Name: treatment_plans treatment_plans_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plans
    ADD CONSTRAINT treatment_plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: treatment_plans treatment_plans_dentist_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plans
    ADD CONSTRAINT treatment_plans_dentist_id_fkey FOREIGN KEY (dentist_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: treatment_plans treatment_plans_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plans
    ADD CONSTRAINT treatment_plans_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

--
-- Name: treatment_plans treatment_plans_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatment_plans
    ADD CONSTRAINT treatment_plans_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: treatments treatments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatments
    ADD CONSTRAINT treatments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: users users_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

--
-- Name: appointment_status_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.appointment_status_events ENABLE ROW LEVEL SECURITY;

--
-- Name: appointments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

--
-- Name: clinic_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clinic_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: clinic_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clinic_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: clinical_procedures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clinical_procedures ENABLE ROW LEVEL SECURITY;

--
-- Name: expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_line_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;

--
-- Name: invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: operatories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.operatories ENABLE ROW LEVEL SECURITY;

--
-- Name: patient_allergies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patient_allergies ENABLE ROW LEVEL SECURITY;

--
-- Name: patient_conditions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patient_conditions ENABLE ROW LEVEL SECURITY;

--
-- Name: patient_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patient_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: patient_medications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patient_medications ENABLE ROW LEVEL SECURITY;

--
-- Name: patient_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patient_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: patients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: perio_exams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.perio_exams ENABLE ROW LEVEL SECURITY;

--
-- Name: perio_measurements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.perio_measurements ENABLE ROW LEVEL SECURITY;

--
-- Name: perio_tooth_findings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.perio_tooth_findings ENABLE ROW LEVEL SECURITY;

--
-- Name: procedure_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.procedure_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: reminders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

--
-- Name: salary_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salary_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_availability; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_availability ENABLE ROW LEVEL SECURITY;

--
-- Name: appointment_status_events tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.appointment_status_events USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: appointments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.appointments USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: clinic_audit_log tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.clinic_audit_log USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: clinic_settings tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.clinic_settings USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: clinical_procedures tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.clinical_procedures USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: expenses tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.expenses USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: invoice_line_items tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.invoice_line_items USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: invoices tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.invoices USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: ledger_entries tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.ledger_entries USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: operatories tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.operatories USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: patient_allergies tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.patient_allergies USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: patient_conditions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.patient_conditions USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: patient_documents tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.patient_documents USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: patient_medications tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.patient_medications USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: patient_notes tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.patient_notes USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: patients tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.patients USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: payments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.payments USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: perio_exams tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.perio_exams USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: perio_measurements tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.perio_measurements USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: perio_tooth_findings tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.perio_tooth_findings USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: procedure_codes tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.procedure_codes USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: reminders tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.reminders USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: salary_payments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.salary_payments USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: staff_availability tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.staff_availability USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: tenants tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.tenants USING ((id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: tooth_conditions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.tooth_conditions USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: treatment_plan_items tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.treatment_plan_items USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: treatment_plans tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.treatment_plans USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: treatments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.treatments USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: users tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.users USING ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid));

--
-- Name: tenants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

--
-- Name: tooth_conditions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tooth_conditions ENABLE ROW LEVEL SECURITY;

--
-- Name: treatment_plan_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.treatment_plan_items ENABLE ROW LEVEL SECURITY;

--
-- Name: treatment_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.treatment_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: treatments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.treatments ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO app_user;

--
-- Name: FUNCTION resolve_tenant(p_subdomain text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.resolve_tenant(p_subdomain text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.resolve_tenant(p_subdomain text) TO app_user;

--
-- Name: TABLE appointment_status_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.appointment_status_events TO app_user;

--
-- Name: TABLE appointments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.appointments TO app_user;

--
-- Name: TABLE clinic_audit_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.clinic_audit_log TO app_user;

--
-- Name: TABLE clinic_settings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.clinic_settings TO app_user;

--
-- Name: TABLE clinical_procedures; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.clinical_procedures TO app_user;

--
-- Name: TABLE expenses; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.expenses TO app_user;

--
-- Name: COLUMN expenses.voided_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(voided_at) ON TABLE public.expenses TO app_user;

--
-- Name: COLUMN expenses.voided_by; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(voided_by) ON TABLE public.expenses TO app_user;

--
-- Name: COLUMN expenses.void_reason; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(void_reason) ON TABLE public.expenses TO app_user;

--
-- Name: TABLE invoice_line_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invoice_line_items TO app_user;

--
-- Name: TABLE invoices; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.invoices TO app_user;

--
-- Name: TABLE ledger_entries; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.ledger_entries TO app_user;

--
-- Name: TABLE operatories; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.operatories TO app_user;

--
-- Name: TABLE patient_allergies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.patient_allergies TO app_user;

--
-- Name: TABLE patient_conditions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.patient_conditions TO app_user;

--
-- Name: TABLE patient_documents; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.patient_documents TO app_user;

--
-- Name: TABLE patient_medications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.patient_medications TO app_user;

--
-- Name: TABLE patient_notes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.patient_notes TO app_user;

--
-- Name: TABLE patients; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.patients TO app_user;

--
-- Name: TABLE payments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.payments TO app_user;

--
-- Name: COLUMN payments.voided_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(voided_at) ON TABLE public.payments TO app_user;

--
-- Name: COLUMN payments.voided_by; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(voided_by) ON TABLE public.payments TO app_user;

--
-- Name: COLUMN payments.void_reason; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(void_reason) ON TABLE public.payments TO app_user;

--
-- Name: TABLE perio_exams; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.perio_exams TO app_user;

--
-- Name: TABLE perio_measurements; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.perio_measurements TO app_user;

--
-- Name: TABLE perio_tooth_findings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.perio_tooth_findings TO app_user;

--
-- Name: TABLE plans; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.plans TO app_user;

--
-- Name: TABLE procedure_codes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.procedure_codes TO app_user;

--
-- Name: TABLE reminders; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.reminders TO app_user;

--
-- Name: TABLE salary_payments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.salary_payments TO app_user;

--
-- Name: TABLE staff_availability; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.staff_availability TO app_user;

--
-- Name: TABLE tenants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.tenants TO app_user;

--
-- Name: COLUMN tenants.name; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(name) ON TABLE public.tenants TO app_user;

--
-- Name: COLUMN tenants.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE public.tenants TO app_user;

--
-- Name: TABLE tooth_conditions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tooth_conditions TO app_user;

--
-- Name: TABLE treatment_plan_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.treatment_plan_items TO app_user;

--
-- Name: TABLE treatment_plans; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.treatment_plans TO app_user;

--
-- Name: TABLE treatments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.treatments TO app_user;

--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO app_user;

--
-- PostgreSQL database dump complete
--

`;
