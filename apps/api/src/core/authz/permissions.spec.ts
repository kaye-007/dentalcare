import {
  ADMIN_ONLY,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  can,
  canAll,
  isRole,
  normalizeRole,
  permissionsFor,
} from './permissions';

describe('permission matrix', () => {
  it('declares every permission exactly once', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('grants admin every declared permission', () => {
    for (const p of PERMISSIONS) expect(can('admin', p)).toBe(true);
    expect(ROLE_PERMISSIONS.admin.size).toBe(PERMISSIONS.length);
  });

  it('declares no permission outside the canonical list', () => {
    for (const role of ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(p);
      }
    }
  });

  /**
   * The load-bearing test. ADMIN_ONLY and the receptionist set must PARTITION
   * PERMISSIONS: no overlap, nothing left over. A capability added without a
   * decision about who holds it lands in neither list and fails here, rather
   * than defaulting to whichever side the author forgot about.
   */
  it('partitions every permission between reception and the doctor', () => {
    const reception = ROLE_PERMISSIONS.receptionist;
    const adminOnly = new Set(ADMIN_ONLY);

    const overlap = ADMIN_ONLY.filter((p) => reception.has(p));
    expect(overlap).toEqual([]);

    const unassigned = PERMISSIONS.filter(
      (p) => !reception.has(p) && !adminOnly.has(p),
    );
    expect(unassigned).toEqual([]);

    expect(reception.size + ADMIN_ONLY.length).toBe(PERMISSIONS.length);
  });

  it('withholds every admin-only capability from reception', () => {
    for (const p of ADMIN_ONLY) expect(can('receptionist', p)).toBe(false);
  });

  it('keeps wages, the aggregate finances and pricing with the doctor', () => {
    // The three things Kaye named explicitly.
    expect(can('receptionist', 'payroll:read')).toBe(false);
    expect(can('receptionist', 'payroll:manage')).toBe(false);
    expect(can('receptionist', 'reports:read')).toBe(false);
    // And the quiet ways round them.
    expect(can('receptionist', 'treatments:manage')).toBe(false);
    expect(can('receptionist', 'staff:manage')).toBe(false);
    expect(can('receptionist', 'settings:manage')).toBe(false);
  });

  it('lets reception run the whole clinic day', () => {
    expect(
      canAll('receptionist', [
        'patients:read',
        'patients:write',
        'appointments:read',
        'appointments:write',
        'operatories:manage',
        'clinical:read',
        'clinical:write',
        'treatments:read',
        'invoices:read',
        'invoices:write',
        'payments:read',
        'payments:write',
        'expenses:read',
        'expenses:write',
        'documents:read',
        'documents:write',
        'reminders:send',
      ]),
    ).toBe(true);
  });

  it('gives reception no destructive capability', () => {
    for (const p of ['invoices:delete', 'documents:delete'] as const) {
      expect(can('receptionist', p)).toBe(false);
    }
  });

  it('lets reception undo money without erasing it', () => {
    // The distinction R2 is built on: she can reverse a mistyped cash payment
    // herself, and there is no permission anywhere that deletes one — the
    // database role lost DELETE on those tables in migration 0018.
    expect(can('receptionist', 'payments:void')).toBe(true);
    expect(can('receptionist', 'expenses:void')).toBe(true);
    expect(PERMISSIONS.filter((p) => p.endsWith(':delete')).sort()).toEqual([
      'documents:delete',
      'invoices:delete',
    ]);
  });

  it('keeps the activity trail readable only by the doctor', () => {
    // Reading every entry is most of the way to knowing which to work around.
    expect(can('receptionist', 'audit:read')).toBe(false);
    expect(can('admin', 'audit:read')).toBe(true);
  });

  it('treats canAll as AND, with an empty list vacuously true', () => {
    expect(canAll('receptionist', [])).toBe(true);
    expect(canAll('receptionist', ['invoices:write'])).toBe(true);
    expect(canAll('receptionist', ['invoices:write', 'invoices:delete'])).toBe(false);
  });

  it('returns a sorted, complete permission list per role', () => {
    for (const role of ROLES) {
      const list = permissionsFor(role);
      expect(list).toEqual([...list].sort());
      expect(new Set(list).size).toBe(list.length);
      expect(list.every((p) => can(role, p))).toBe(true);
    }
  });
});

describe('role resolution', () => {
  it('recognises exactly the two current roles', () => {
    expect(ROLES).toEqual(['admin', 'receptionist']);
    for (const r of ROLES) expect(isRole(r)).toBe(true);
    for (const bad of ['owner', 'frontdesk', 'dentist', 'Admin', '', null, undefined, 7, {}]) {
      expect(isRole(bad)).toBe(false);
    }
  });

  it('maps every retired role to the successor migration 0017 gave its rows', () => {
    expect(normalizeRole('owner')).toBe('admin');
    expect(normalizeRole('dentist')).toBe('admin');
    expect(normalizeRole('frontdesk')).toBe('receptionist');
    expect(normalizeRole('reception')).toBe('receptionist');
  });

  it('never lets a legacy desk role reach wages or the aggregate finances', () => {
    for (const legacy of ['frontdesk', 'reception'] as const) {
      const role = normalizeRole(legacy)!;
      expect(can(role, 'reports:read')).toBe(false);
      expect(can(role, 'payroll:read')).toBe(false);
      expect(can(role, 'staff:manage')).toBe(false);
    }
  });

  it('passes current roles through untouched', () => {
    for (const r of ROLES) expect(normalizeRole(r)).toBe(r);
  });

  it('returns null for anything unrecognised so callers fail closed', () => {
    for (const bad of ['superuser', 'OWNER', '', null, undefined, 42, {}, []]) {
      expect(normalizeRole(bad)).toBeNull();
    }
  });
});
