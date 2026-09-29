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
  type Permission,
  type Role,
} from './permissions';

const NON_ADMIN = ROLES.filter((r): r is Exclude<Role, 'admin'> => r !== 'admin');

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
   * The load-bearing test. ADMIN_ONLY must be EXACTLY the set of permissions
   * that no other role holds. A capability added without a decision about who
   * holds it is held by nobody but admin and is missing from ADMIN_ONLY, so it
   * fails here rather than defaulting to whichever side the author forgot.
   */
  it('makes ADMIN_ONLY exactly the permissions no other role holds', () => {
    const heldElsewhere = new Set<Permission>(
      NON_ADMIN.flatMap((r) => [...ROLE_PERMISSIONS[r]]),
    );

    const leaked = ADMIN_ONLY.filter((p) => heldElsewhere.has(p));
    expect(leaked).toEqual([]);

    const undecided = PERMISSIONS.filter(
      (p) => !heldElsewhere.has(p) && !ADMIN_ONLY.includes(p),
    );
    expect(undecided).toEqual([]);
  });

  it.each(NON_ADMIN)('withholds every admin-only capability from %s', (role) => {
    for (const p of ADMIN_ONLY) expect(can(role, p)).toBe(false);
  });

  it.each(NON_ADMIN)(
    'keeps paying wages, pricing and configuration away from %s',
    (role) => {
      expect(can(role, 'payroll:manage')).toBe(false);
      expect(can(role, 'treatments:manage')).toBe(false);
      expect(can(role, 'staff:manage')).toBe(false);
      expect(can(role, 'settings:manage')).toBe(false);
    },
  );

  /**
   * Reading wages and the aggregate finances used to be admin-only. The
   * accountant (0013) now reads both, because preparing the books and the
   * payroll is the job; every role that treats patients or runs the desk
   * still sees neither.
   */
  it('shows wages and the aggregate finances to the administrator and the accountant only', () => {
    expect(ROLES.filter((r) => can(r, 'payroll:read')).sort()).toEqual([
      'accountant',
      'admin',
    ]);
    expect(ROLES.filter((r) => can(r, 'reports:read')).sort()).toEqual([
      'accountant',
      'admin',
    ]);
  });

  it('lets the accountant read the money and change nothing', () => {
    const held = [...ROLE_PERMISSIONS.accountant];
    const writes = held.filter((p) => !p.endsWith(':read'));
    expect(writes).toEqual([]);
    for (const p of [
      'invoices:read',
      'payments:read',
      'expenses:read',
      'drawer:read',
    ] as const) {
      expect(can('accountant', p)).toBe(true);
    }
  });

  it('keeps the clinical record and patient files away from the accountant', () => {
    for (const p of [
      'patients:read',
      'clinical:read',
      'documents:read',
      'audit:read',
    ] as const) {
      expect(can('accountant', p)).toBe(false);
    }
  });

  it('lets the cash handlers run a drawer and only the administrator approve one', () => {
    expect(ROLES.filter((r) => can(r, 'drawer:operate')).sort()).toEqual([
      'admin',
      'receptionist',
    ]);
    expect(ROLES.filter((r) => can(r, 'drawer:approve'))).toEqual(['admin']);
    expect(ROLES.filter((r) => can(r, 'drawer:read')).sort()).toEqual([
      'accountant',
      'admin',
    ]);
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
        'history:write',
        'treatments:read',
        'invoices:read',
        'invoices:write',
        'invoices:fiscalize',
        'payments:read',
        'payments:write',
        'documents:read',
        'documents:write',
        'reminders:send',
      ]),
    ).toBe(true);
  });

  it.each(NON_ADMIN)('gives %s no destructive capability', (role) => {
    for (const p of ['invoices:delete', 'documents:delete'] as const) {
      expect(can(role, p)).toBe(false);
    }
  });

  /**
   * The owner's decision of 2026-09-28: reception takes money but does not
   * reverse it, and does not see what the clinic spends. It still reads the
   * chart, which it explains the bill from.
   */
  it('lets reception take money, but not reverse it or see the spending', () => {
    expect(canAll('receptionist', ['payments:write', 'clinical:read'])).toBe(true);
    for (const p of ['payments:void', 'expenses:void', 'expenses:read'] as const) {
      expect(can('receptionist', p)).toBe(false);
    }
  });

  it('leaves reversing money to the administrator alone', () => {
    expect(ROLES.filter((r) => can(r, 'payments:void'))).toEqual(['admin']);
    expect(ROLES.filter((r) => can(r, 'expenses:void'))).toEqual(['admin']);
  });

  it('shows the spending to the administrator and the accountant only', () => {
    expect(ROLES.filter((r) => can(r, 'expenses:read')).sort()).toEqual([
      'accountant',
      'admin',
    ]);
  });

  it('undoes money without erasing it: nothing but a document or an adjustment deletes', () => {
    expect(PERMISSIONS.filter((p) => p.endsWith(':delete')).sort()).toEqual([
      'documents:delete',
      'invoices:delete',
    ]);
  });

  it('keeps the activity trail readable only by the administrator', () => {
    for (const role of NON_ADMIN) expect(can(role, 'audit:read')).toBe(false);
    expect(can('admin', 'audit:read')).toBe(true);
  });

  /**
   * Signing is clinical accountability. The people who chart on somebody
   * else's behalf — assistants and the front desk — record entries that stay
   * unsigned until a clinician signs them.
   */
  it('lets only accountable clinicians sign', () => {
    const signers = ROLES.filter((r) => can(r, 'clinical:sign')).sort();
    expect(signers).toEqual(['admin', 'dentist', 'hygienist']);
  });

  /**
   * The front desk reads the clinical record and never writes it: not the
   * odontogram, not a perio exam, not a treatment plan. What a patient tells
   * reception at intake — allergies, conditions, medications, notes — is a
   * separate grant she keeps.
   */
  it('keeps the chart, perio and treatment plans out of reception’s hands', () => {
    expect(can('receptionist', 'clinical:read')).toBe(true);
    expect(can('receptionist', 'clinical:write')).toBe(false);
    expect(can('receptionist', 'clinical:sign')).toBe(false);
    expect(can('receptionist', 'plans:write')).toBe(false);
    expect(can('receptionist', 'history:write')).toBe(true);

    const charters = ROLES.filter((r) => can(r, 'clinical:write')).sort();
    expect(charters).toEqual(['admin', 'assistant', 'dentist', 'hygienist']);
    expect(ROLES.filter((r) => can(r, 'plans:write')).sort()).toEqual(charters);
  });

  it('lets everyone who works with patients take a medical history', () => {
    for (const role of ROLES.filter((r) => r !== 'accountant')) {
      expect(can(role, 'history:write')).toBe(true);
    }
    expect(can('accountant', 'history:write')).toBe(false);
  });

  it('lets whoever takes money issue the fiscal invoice, and nobody else', () => {
    const fiscal = ROLES.filter((r) => can(r, 'invoices:fiscalize')).sort();
    expect(fiscal).toEqual(['admin', 'receptionist']);
    for (const role of fiscal) expect(can(role, 'payments:write')).toBe(true);
  });

  /**
   * Issuing and answering for the queue are different jobs: the accountant
   * reconciles what the authority refused without being able to issue, and
   * no clinical role sees either.
   */
  it('shows the fiscal queue to the desk, the accountant and the administrator', () => {
    expect(ROLES.filter((r) => can(r, 'fiscal:read')).sort()).toEqual([
      'accountant',
      'admin',
      'receptionist',
    ]);
    expect(can('accountant', 'invoices:fiscalize')).toBe(false);
    for (const role of ['dentist', 'hygienist', 'assistant'] as const) {
      expect(can(role, 'fiscal:read')).toBe(false);
    }
  });

  it('keeps bulk import with the administrator', () => {
    expect(ROLES.filter((r) => can(r, 'patients:import'))).toEqual(['admin']);
  });

  it('keeps assistants and hygienists away from money entirely', () => {
    for (const role of ['assistant', 'hygienist'] as const) {
      for (const p of PERMISSIONS.filter(
        (x) =>
          x.startsWith('invoices:') ||
          x.startsWith('payments:') ||
          x.startsWith('expenses:'),
      )) {
        expect(can(role, p)).toBe(false);
      }
    }
  });

  it('lets a dentist bill their own work but not take or reverse payments', () => {
    expect(can('dentist', 'invoices:write')).toBe(true);
    expect(can('dentist', 'payments:read')).toBe(true);
    expect(can('dentist', 'payments:write')).toBe(false);
    expect(can('dentist', 'payments:void')).toBe(false);
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
  it('recognises exactly the six current roles', () => {
    expect(ROLES).toEqual([
      'admin',
      'dentist',
      'hygienist',
      'assistant',
      'receptionist',
      'accountant',
    ]);
    for (const r of ROLES) expect(isRole(r)).toBe(true);
    for (const bad of ['owner', 'frontdesk', 'Admin', '', null, undefined, 7, {}]) {
      expect(isRole(bad)).toBe(false);
    }
  });

  it('maps every retired role to its successor', () => {
    expect(normalizeRole('owner')).toBe('admin');
    expect(normalizeRole('frontdesk')).toBe('receptionist');
    expect(normalizeRole('reception')).toBe('receptionist');
  });

  /**
   * 0017 once mapped `dentist` to admin. Now that `dentist` is a narrower role
   * again, a leftover mapping would promote every associate to administrator.
   */
  it('resolves dentist to dentist, never to admin', () => {
    expect(normalizeRole('dentist')).toBe('dentist');
    expect(can(normalizeRole('dentist')!, 'payroll:read')).toBe(false);
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
    for (const bad of [
      'superuser',
      'OWNER',
      '',
      null,
      undefined,
      42,
      {},
      [],
      'toString',
      'constructor',
    ]) {
      expect(normalizeRole(bad)).toBeNull();
    }
  });
});
