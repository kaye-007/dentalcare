/**
 * How this app TALKS about roles, and one convenience over the shared matrix.
 *
 * The matrix itself — which permissions exist, which role holds which — lives
 * in @dentalcare/shared. This file used to restate every permission by hand
 * under a note saying to keep them in step with the API. They did happen to
 * agree; they would not have for long.
 *
 * Nothing here is a security boundary and it never was. It exists to hide
 * controls a user cannot use. Everything reachable from the browser is
 * checked again by PermissionsGuard on the API, which is the authoritative
 * decision. If the two ever disagree, the API wins and the user sees a 403.
 */
import { can, type Permission, type Role } from '@dentalcare/shared';

// Re-exported by name so a component can ask this module for "everything
// about a role" without also importing the shared package. Named, not a star
// re-export: Rollup cannot see through one of those into a CommonJS package.
export { ROLES, type Permission, type Role } from '@dentalcare/shared';

/** Human labels for role pickers and the user card. */
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  dentist: 'Dentist',
  hygienist: 'Hygienist',
  assistant: 'Assistant',
  receptionist: 'Reception',
  accountant: 'Accountant',
};

/** One-line description of each role, shown when assigning one. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin:
    'Runs the clinic. Everything the other roles can do, plus salaries, financial reports, pricing, clinic settings, staff accounts and the activity trail.',
  dentist:
    'Treats and signs: the chart, procedures, perio exams, treatment plans and documents, and invoices for their own work. Cannot take payments, see salaries or financial reports, or change prices, settings or accounts.',
  hygienist:
    'Treats and signs periodontal exams and cleanings, and keeps the chart and documents. No access to invoices, payments or financial reports.',
  assistant:
    'Charts on a clinician’s behalf and files documents, but cannot sign — a clinician signs what an assistant records. Can book appointments. No access to money.',
  receptionist:
    'Runs the day: booking, patients, the medical history at intake, invoices, fiscal invoices, payments, expenses and documents. Runs a cash drawer when the clinic uses one. Can read the chart and treatment plans but not change them. Can void a mistaken payment with a reason — never delete one. Cannot see salaries or financial reports, and cannot change prices, settings or accounts.',
  accountant:
    'Reads the money: invoices, payments, expenses, cash drawer reports, financial reports and payroll. Changes nothing, and never sees patient records, the chart or documents.',
};

/**
 * Roles that treat patients, and so get a column in the day view and appear in
 * clinician pickers. Presentation only: who may SIGN is `clinical:sign`.
 */
export const PRACTITIONER_ROLES: readonly Role[] = ['admin', 'dentist', 'hygienist'];

export function isPractitioner(role: Role | string | undefined): boolean {
  return (PRACTITIONER_ROLES as readonly string[]).includes(role ?? '');
}

/**
 * `can`, tolerating the signed-out case.
 *
 * The shared matrix takes a Role; a component often has `Role | undefined`
 * because the session has not loaded yet. Answering "no" for nobody is the
 * fail-closed direction, and it keeps the check at the call site to one
 * expression instead of a guard plus a call.
 */
export function roleCan(role: Role | undefined, permission: Permission): boolean {
  return role ? can(role, permission) : false;
}
