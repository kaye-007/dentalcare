/**
 * The permission matrix — the single source of truth for what each clinic
 * role may do.
 *
 * It lives in @dentalcare/shared because the clinic SPA held a second copy,
 * hand-maintained, under the note "keep in step with
 * apps/api/src/core/authz/permissions.ts". The two happened to agree — which
 * is luck rather than process, and the luck would have run out the first time
 * someone added a capability.
 *
 * The enforcement did NOT move. PermissionsGuard, the @RequirePermissions
 * decorator and every authorization decision stay in the API, which is the
 * only place they mean anything. What is shared is the matrix, so that the
 * controls the UI hides are exactly the ones the API would refuse.
 *
 * Design notes
 * ------------
 * 1. Routes declare the PERMISSION they need, never the role. Adding a role
 *    or moving a capability between roles is then a change to this file
 *    alone, not a sweep across every controller.
 *
 * 2. This is authorization (what you may do), layered on top of tenant
 *    isolation (whose data you can see). Isolation is enforced by PostgreSQL
 *    Row-Level Security and is NOT weakened by anything here — a role with
 *    every permission in this file still cannot read another clinic's rows,
 *    because `app_user` is NOBYPASSRLS and the row filter is applied by the
 *    database. Permissions narrow access WITHIN a tenant; RLS bounds it
 *    BETWEEN tenants. Neither substitutes for the other.
 *
 * 3. `admin` is defined as "every permission" by construction rather than by
 *    an enumerated list, so a newly added permission can never be silently
 *    missing from the administrator role.
 *
 * 4. Every other role is enumerated, NOT derived by subtraction. A permission
 *    added tomorrow is therefore admin-only until someone deliberately grants
 *    it — the fail-closed direction. `ADMIN_ONLY` records the same decision
 *    from the other side, and a spec asserts that ADMIN_ONLY is exactly the
 *    set no other role holds, so adding a capability without deciding who
 *    holds it fails the build rather than leaking.
 *
 * The role model (migration 0003_clinical-roles)
 * ----------------------------------------------
 * The two-role model (0017) fitted a single-dentist practice: the doctor was
 * the administrator and reception ran the day. It broke on the second
 * dentist, who had to be either an administrator — salaries, the audit trail,
 * every account — or reception, with no clinical accountability at all.
 *
 *   admin         runs the clinic; everything
 *   dentist       treats and signs; bills from their own work; no money in
 *                 aggregate, no wages, no configuration
 *   hygienist     treats and signs (perio, cleanings); no billing
 *   assistant     charts on a clinician's behalf; cannot sign; no money
 *   receptionist  runs the day: booking, patients, intake history, billing,
 *                 collecting, fiscal invoices. Reads the chart and the plans;
 *                 never writes them (0009 — see RECEPTIONIST below)
 *   accountant    reads the money: invoices, payments, expenses, drawer
 *                 reports, the aggregate finances and payroll. Writes nothing
 *                 and never opens the clinical record (0013)
 *
 * `users.position` remains a free-text job title and grants nothing.
 *
 * There is no separate `owner`. The administrator IS the owner: the role that
 * holds everything, including the pay and approval decisions. `owner` stays a
 * legacy spelling of admin below, which is the direction that never moves
 * authority.
 */

/** Every capability the clinic plane can gate on. */
export const PERMISSIONS = [
  'patients:read',
  'patients:write',
  /**
   * Bulk import from a spreadsheet or a legacy system. Administrator only: one
   * file creates hundreds of records and can post opening balances to the
   * ledger, which is money arriving without anyone taking it.
   */
  'patients:import',

  'appointments:read',
  'appointments:write',

  /** Treatment rooms and who works when. Clinic configuration. */
  'operatories:manage',
  /**
   * Change ANOTHER person's working hours. Everyone may edit their own
   * without this — see AvailabilityController.assertMayEdit.
   */
  'availability:manage',

  /** Odontogram, tooth records and clinical notes. */
  'clinical:read',
  /**
   * Record and correct UNSIGNED clinical entries, and withdraw one as
   * entered in error. Nothing clinical can be deleted by anyone: the database
   * role holds no DELETE on those tables (0004).
   */
  'clinical:write',
  /**
   * Sign a procedure or a periodontal exam. A signed entry is locked by the
   * database — it can be withdrawn as entered in error, with a reason, by
   * someone who could have signed it, and never edited. Held by the people who
   * can be clinically accountable for an entry, which is why assistants and
   * reception, who chart on a clinician's behalf, do not hold it.
   */
  'clinical:sign',
  /**
   * What a patient tells the clinic at intake: allergies, conditions,
   * medications, and notes on the record. Split from `clinical:write` so the
   * front desk can take a medical history without being able to touch the
   * odontogram, a perio chart or a procedure.
   */
  'history:write',
  /**
   * Create and change treatment plans and their lines. Split from
   * `clinical:write` for the same reason: a plan is a clinical proposal, and
   * reception bills from it rather than writes it.
   */
  'plans:write',

  'treatments:read',
  /** Create/modify the priced treatment catalogue. */
  'treatments:manage',

  'invoices:read',
  'invoices:write',
  'invoices:delete',
  /**
   * Register an invoice with the tax authority (Albanian fiscalization). Held
   * by whoever takes the money, because a fiscal invoice is issued at payment.
   * Once registered an invoice cannot be cancelled, only corrected.
   */
  'invoices:fiscalize',
  /**
   * The fiscal registration queue: what is still waiting for the tax
   * authority, what it refused, and how close each one is to the 48-hour
   * limit the law allows. Held by whoever answers for it — the desk that
   * issued them, the accountant who reconciles them, the administrator.
   */
  'fiscal:read',

  'payments:read',
  'payments:write',
  /**
   * Reverse a recorded payment. NOT a delete — 0018 revoked that privilege
   * from the database role entirely. Reception holds this so a mistyped cash
   * payment can be fixed without waiting for the doctor; the reversal, the
   * reason and her name are permanent.
   */
  'payments:void',

  'expenses:read',
  'expenses:write',
  /** Reverse a recorded expense. Same shape as payments:void. */
  'expenses:void',

  /** Patient documents: X-rays, consent forms, referrals. */
  'documents:read',
  'documents:write',
  /** Removing a radiograph is destructive; kept separate from write. */
  'documents:delete',

  'staff:read',
  /** Create staff, change roles, reset passwords. */
  'staff:manage',

  /** Salary amounts and the salary payment log. */
  'payroll:read',
  'payroll:manage',

  'settings:read',
  'settings:manage',

  /**
   * The rolled-up financial picture: revenue, expenses, profit, production by
   * clinician. Distinct from `invoices:read`, which is the day-to-day billing
   * the front desk works from.
   */
  'reports:read',

  'reminders:read',
  'reminders:send',

  /** See the stock list and what is running low. */
  'inventory:read',
  /**
   * Record a movement: stock received, stock used, a count that disagreed.
   * Reception holds this deliberately — she is the one who notices the gloves
   * are nearly gone, and an inventory only anyone senior can update is an
   * inventory nobody updates.
   */
  'inventory:write',
  /**
   * Define WHAT is stocked and what "low" means for it — adding an item,
   * archiving one, moving a minimum level. Kept apart from `inventory:write`
   * because lowering a minimum silences a warning, which is the one change
   * here that can hide a problem rather than record one.
   */
  'inventory:manage',

  /**
   * Lab work (0020): the crowns, bridges and appliances made by a dental
   * laboratory, where each one is, and when it is due back. Clinical staff
   * order it; reception sends it, chases it and signs it back in, so both
   * sides hold both. Not the accountant: a lab job names the patient and the
   * treatment, and the lab's charges reach the reports without it.
   */
  'lab:read',
  /** Order lab work, move it along (sent, received, fitted), and name the lab. */
  'lab:write',

  /**
   * The clinic activity trail and the record-access log. Doctor-only: the
   * logs exist so that the person being recorded cannot curate them, and
   * reading every entry is most of the way to knowing which ones to work
   * around.
   */
  'audit:read',

  /**
   * Run a cash drawer session: open it with a float, take cash into it, drop
   * cash to the safe, count it and close it (0014). The person who holds the
   * cash is the person whose name is on the session.
   */
  'drawer:operate',
  /** Every drawer session and shift report, not only one's own. */
  'drawer:read',
  /**
   * Accept a variance over the approval threshold, authorise a payout, and
   * force-close a session somebody left open. Never held by the people whose
   * counts it approves.
   */
  'drawer:approve',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Access roles. Distinct from `users.position`, which is a job title only. */
export const ROLES = [
  'admin',
  'dentist',
  'hygienist',
  'assistant',
  'receptionist',
  'accountant',
] as const;
export type Role = (typeof ROLES)[number];

/**
 * Held by the administrator alone. Each line is a decision, not an oversight:
 *
 *  - `treatments:manage` — repricing the catalogue changes what every future
 *    patient is charged. It is the quietest way to move money in a clinic.
 *  - `settings:manage`   — VAT rate and currency silently rewrite billing.
 *  - `staff:manage`      — without this, anyone could promote themselves to
 *    administrator and the rest of this file would be decoration.
 *  - `payroll:manage`    — paying wages and salaries. Reading them is shared
 *    with the accountant, who prepares the payroll (0013).
 *  - `drawer:approve`    — accepting a cash variance or a payout. Approval by
 *    anyone who also counts cash is no approval.
 *  - `invoices:delete`  — posts a ledger adjustment (credit, write-off).
 *  - `documents:delete` — removing a radiograph.
 *  - `audit:read`       — see above.
 *  - `inventory:manage` — what is stocked and what counts as low. Moving a
 *    minimum level silences a warning rather than recording a fact.
 *  - `patients:import`  — hundreds of records and opening balances at once.
 *
 * Note what is NOT here: reception may VOID a payment or an expense. She has
 * to be able to fix a mistyped cash payment without waiting for the doctor.
 * What she cannot do is make one disappear — 0018 took DELETE away from the
 * database role, so a void is a reversal that stays on the record forever.
 */
export const ADMIN_ONLY: readonly Permission[] = [
  'treatments:manage',
  'invoices:delete',
  'documents:delete',
  'audit:read',
  'staff:manage',
  'payroll:manage',
  'settings:manage',
  'inventory:manage',
  'patients:import',
  'drawer:approve',
];

/**
 * An associate dentist. Treats, charts, signs, and bills the work they did —
 * an invoice raised from their own treatment plan should not wait for the
 * administrator. Sees whether it was paid; does not take or void payments,
 * and never sees the clinic's aggregate finances or anyone's salary.
 */
const DENTIST: readonly Permission[] = [
  'patients:read',
  'patients:write',
  'appointments:read',
  'appointments:write',
  'clinical:read',
  'clinical:write',
  'clinical:sign',
  'history:write',
  'plans:write',
  'treatments:read',
  'invoices:read',
  'invoices:write',
  'payments:read',
  'documents:read',
  'documents:write',
  'staff:read',
  'settings:read',
  'reminders:read',
  'reminders:send',
  'inventory:read',
  'inventory:write',
  'lab:read',
  'lab:write',
];

/**
 * A hygienist. Clinically accountable for their own work — perio exams and
 * cleanings — so signs it. Nothing to do with money.
 */
const HYGIENIST: readonly Permission[] = [
  'patients:read',
  'patients:write',
  'appointments:read',
  'appointments:write',
  'clinical:read',
  'clinical:write',
  'clinical:sign',
  'history:write',
  'plans:write',
  'treatments:read',
  'documents:read',
  'documents:write',
  'staff:read',
  'settings:read',
  'reminders:read',
  'inventory:read',
  'inventory:write',
  'lab:read',
  'lab:write',
];

/**
 * A dental assistant. Charts what the clinician dictates and files the
 * radiographs, but an entry they make stays unsigned until a clinician signs
 * it. Can book, cannot edit a patient's demographics, and has no access to
 * money.
 */
const ASSISTANT: readonly Permission[] = [
  'patients:read',
  'appointments:read',
  'appointments:write',
  'clinical:read',
  'clinical:write',
  'history:write',
  'plans:write',
  'treatments:read',
  'documents:read',
  'documents:write',
  'staff:read',
  'settings:read',
  'reminders:read',
  'inventory:read',
  'inventory:write',
  'lab:read',
  'lab:write',
];

/**
 * Front desk. Runs the day end to end: books, registers and edits patients,
 * takes the medical history at intake, bills, collects, issues fiscal
 * invoices, files documents and chases reminders.
 *
 * Reads the chart, the perio exams and the treatment plans — she explains the
 * bill from them — but writes none of them. Reception used to hold
 * `clinical:write` and "chart on a clinician's behalf"; the clinic owner's
 * rule is now that the odontogram, the perio chart and the plan are written
 * by clinical staff only, so that grant was split into `history:write` (kept)
 * and `clinical:write` / `plans:write` (withdrawn).
 *
 * Cannot sign, see aggregate finances or salaries, change prices, settings or
 * accounts, read the activity trail, or delete anything. The money evidence
 * she does touch — payments, voids, the ledger — is append-only in the
 * database regardless of what this list says.
 */
const RECEPTIONIST: readonly Permission[] = [
  'patients:read',
  'patients:write',
  'appointments:read',
  'appointments:write',
  'operatories:manage',
  'availability:manage',
  'clinical:read',
  'history:write',
  'treatments:read',
  'invoices:read',
  'invoices:write',
  'invoices:fiscalize',
  'fiscal:read',
  'payments:read',
  'payments:write',
  'payments:void',
  'expenses:read',
  'expenses:write',
  'expenses:void',
  'documents:read',
  'documents:write',
  'staff:read',
  'settings:read',
  'reminders:read',
  'reminders:send',
  'inventory:read',
  'inventory:write',
  'lab:read',
  'lab:write',
  'drawer:operate',
];

/**
 * The clinic's accountant, in-house or external. Reads every figure the books
 * are made from — invoices and payments, expenses, cash drawer sessions and
 * their variances, the aggregate finances, and payroll so wages can be
 * prepared — and changes none of them.
 *
 * Deliberately NOT here: `patients:read`, `clinical:read`, `documents:read`.
 * An invoice carries the patient's name because the invoice does; the chart,
 * the history and the X-rays are nothing an accountant needs, and health data
 * is shared on need, not on convenience.
 */
const ACCOUNTANT: readonly Permission[] = [
  'invoices:read',
  'fiscal:read',
  'payments:read',
  'expenses:read',
  'reports:read',
  'payroll:read',
  'staff:read',
  'settings:read',
  'drawer:read',
];

/**
 * Role -> permission sets. Admin is derived from PERMISSIONS so it cannot
 * drift out of date as capabilities are added.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> =
  Object.freeze({
    admin: new Set<Permission>(PERMISSIONS),
    dentist: new Set<Permission>(DENTIST),
    hygienist: new Set<Permission>(HYGIENIST),
    assistant: new Set<Permission>(ASSISTANT),
    receptionist: new Set<Permission>(RECEPTIONIST),
    accountant: new Set<Permission>(ACCOUNTANT),
  });

/** Does `role` hold `permission`? */
export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Does `role` hold EVERY listed permission? Empty list => true. */
export function canAll(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => can(role, p));
}

/** All permissions held by `role`, sorted — for /auth/me and UI gating. */
export function permissionsFor(role: Role): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])].sort();
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Roles used before the current model, mapped to their successors.
 *
 * Access tokens are short-lived but not instantly revoked, so a session held
 * across a deploy may still present an old value. Rather than 403 a working
 * session, normalise it here; the next refresh re-reads the row and mints the
 * current value.
 *
 * `dentist` is NOT here any more. 0017 mapped it to admin and converted every
 * row; 0003_clinical-roles made it a real, narrower role again. Every token
 * that carried the pre-0017 spelling expired long before that migration, and
 * a mapping left behind would now PROMOTE every associate dentist to
 * administrator — the one direction this table must never move authority.
 */
const LEGACY_ROLES: Readonly<Record<string, Role>> = Object.freeze({
  owner: 'admin',
  frontdesk: 'receptionist',
  /** Pre-0011 spelling; harmless to keep, and cheap insurance. */
  reception: 'receptionist',
});

/**
 * Coerce any stored or token-borne role string to a current Role.
 * Returns null when the value is unrecognised — callers must fail closed.
 */
export function normalizeRole(value: unknown): Role | null {
  if (isRole(value)) return value;
  if (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(LEGACY_ROLES, value)
  ) {
    return LEGACY_ROLES[value]!;
  }
  return null;
}
