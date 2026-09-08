/**
 * The permission matrix — the single source of truth for what each clinic
 * role may do.
 *
 * It lives in @dentalcare/shared because the clinic SPA held a second copy,
 * hand-maintained, under the note "keep in step with
 * apps/api/src/core/authz/permissions.ts". The two happened to agree — all 32
 * permissions, the same nine admin-only, the same 23 for reception — which is
 * luck rather than process, and the luck would have run out the first time
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
 *    Row-Level Security and is NOT weakened by anything here — a receptionist
 *    with every permission in this file still cannot read another clinic's
 *    rows, because `app_user` is NOBYPASSRLS and the row filter is applied by
 *    the database. Permissions narrow access WITHIN a tenant; RLS bounds it
 *    BETWEEN tenants. Neither substitutes for the other.
 *
 * 3. `admin` is defined as "every permission" by construction rather than by
 *    an enumerated list, so a newly added permission can never be silently
 *    missing from the administrator role.
 *
 * 4. `receptionist` is enumerated, NOT derived by subtraction. A permission
 *    added tomorrow is therefore admin-only until someone deliberately grants
 *    it — the fail-closed direction. `ADMIN_ONLY` below records the same
 *    decision from the other side, and a spec asserts the two partition
 *    `PERMISSIONS` exactly, so adding a capability without deciding who holds
 *    it fails the build rather than leaking.
 *
 * The two-role model (migration 0017)
 * -----------------------------------
 * A clinic runs on two accounts: the doctor, who is also the administrator,
 * and the front desk. `dentist` is gone. Reception does everything the doctor
 * does except the nine capabilities in `ADMIN_ONLY` — money in aggregate,
 * wages, pricing, user management, clinic configuration, and the destructive
 * operations.
 */

/** Every capability the clinic plane can gate on. */
export const PERMISSIONS = [
  'patients:read',
  'patients:write',

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
  'clinical:write',

  'treatments:read',
  /** Create/modify the priced treatment catalogue. */
  'treatments:manage',

  'invoices:read',
  'invoices:write',
  'invoices:delete',

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

  /**
   * The clinic activity trail. Doctor-only: the log exists so that the person
   * being recorded cannot curate it, and reading every entry is most of the
   * way to knowing which ones to work around.
   */
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Access roles. Distinct from `users.position`, which is a job title only. */
export const ROLES = ['admin', 'receptionist'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Held by the doctor alone. Each line is a decision, not an oversight:
 *
 *  - `treatments:manage` — repricing the catalogue changes what every future
 *    patient is charged. It is the quietest way to move money in a clinic.
 *  - `settings:manage`   — VAT rate and currency silently rewrite billing.
 *  - `staff:manage`      — without this, the front desk could promote itself
 *    to administrator and the rest of this file would be decoration.
 *  - `payroll:*`         — wages and salaries.
 *  - `reports:read`      — the aggregate view: revenue against expenses.
 *  - `invoices:delete`  — posts a ledger adjustment (credit, write-off).
 *  - `documents:delete` — removing a radiograph.
 *  - `audit:read`       — see above.
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
  'payroll:read',
  'payroll:manage',
  'settings:manage',
  'reports:read',
];

/**
 * Front desk. Runs the day end to end: books, charts, bills, collects, files
 * documents and chases reminders. Cannot see the clinic's aggregate finances
 * or anyone's salary, cannot change prices, settings or accounts, and cannot
 * delete.
 */
const RECEPTIONIST: readonly Permission[] = [
  'patients:read',
  'patients:write',
  'appointments:read',
  'appointments:write',
  'operatories:manage',
  'availability:manage',
  'clinical:read',
  'clinical:write',
  'treatments:read',
  'invoices:read',
  'invoices:write',
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
];

/**
 * Role -> permission sets. Admin is derived from PERMISSIONS so it cannot
 * drift out of date as capabilities are added.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> =
  Object.freeze({
    admin: new Set<Permission>(PERMISSIONS),
    receptionist: new Set<Permission>(RECEPTIONIST),
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
 * across the deploy still presents the old value. Rather than 403 a working
 * session, normalise it here; the next refresh mints a token carrying the new
 * value and the mapping stops being consulted for that session.
 *
 * `dentist -> admin` is the one entry that GRANTS authority rather than
 * preserving it. That is the deliberate shape of the two-role model — the
 * doctor is the administrator — and it mirrors exactly what migration 0017
 * did to the stored rows, so a token and its row can never disagree.
 */
const LEGACY_ROLES: Readonly<Record<string, Role>> = Object.freeze({
  owner: 'admin',
  dentist: 'admin',
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
  if (typeof value === 'string' && value in LEGACY_ROLES) {
    return LEGACY_ROLES[value];
  }
  return null;
}
