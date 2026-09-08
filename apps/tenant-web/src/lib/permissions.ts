/**
 * How this app TALKS about roles, and one convenience over the shared matrix.
 *
 * The matrix itself — which permissions exist, which role holds which — moved
 * to @dentalcare/shared. This file used to restate all 32 permissions by hand
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
  admin: 'Doctor',
  receptionist: 'Reception',
};

/** One-line description of each role, shown when assigning one. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin:
    'Runs the clinic. Everything Reception can do, plus salaries, financial reports, pricing, clinic settings and staff accounts.',
  receptionist:
    'Runs the day: booking, patients, the chart, invoices, payments, expenses and documents. Can void a mistaken payment with a reason — never delete one. Cannot see salaries or financial reports, and cannot change prices, settings or accounts.',
};

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
