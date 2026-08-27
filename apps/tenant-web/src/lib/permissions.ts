/**
 * Client-side mirror of the API permission matrix.
 *
 * This exists ONLY to hide controls a user cannot use. It is not a security
 * boundary and must never be treated as one — anything reachable from the
 * browser is enforced again by PermissionsGuard on the API, which is the
 * authoritative check. If the two ever disagree, the API wins and the user
 * sees a 403.
 *
 * Keep in step with apps/api/src/core/authz/permissions.ts.
 */

export const ROLES = ['admin', 'receptionist'] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'patients:read' | 'patients:write'
  | 'appointments:read' | 'appointments:write'
  | 'operatories:manage' | 'availability:manage'
  | 'clinical:read' | 'clinical:write'
  | 'treatments:read' | 'treatments:manage'
  | 'invoices:read' | 'invoices:write' | 'invoices:delete'
  | 'payments:read' | 'payments:write' | 'payments:void'
  | 'expenses:read' | 'expenses:write' | 'expenses:void'
  | 'documents:read' | 'documents:write' | 'documents:delete'
  | 'staff:read' | 'staff:manage'
  | 'payroll:read' | 'payroll:manage'
  | 'settings:read' | 'settings:manage'
  | 'reports:read'
  | 'reminders:read' | 'reminders:send'
  | 'audit:read';

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

/** Held by the doctor alone — mirrors ADMIN_ONLY on the API. */
export const ADMIN_ONLY: Permission[] = [
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

const RECEPTIONIST: Permission[] = [
  'patients:read', 'patients:write',
  'appointments:read', 'appointments:write',
  'operatories:manage', 'availability:manage',
  'clinical:read', 'clinical:write',
  'treatments:read',
  'invoices:read', 'invoices:write',
  'payments:read', 'payments:write', 'payments:void',
  'expenses:read', 'expenses:write', 'expenses:void',
  'documents:read', 'documents:write',
  'staff:read',
  'settings:read',
  'reminders:read', 'reminders:send',
];

const ALL: Permission[] = [...new Set<Permission>([...RECEPTIONIST, ...ADMIN_ONLY])];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(ALL),
  receptionist: new Set(RECEPTIONIST),
};

export function roleCan(role: Role | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}
