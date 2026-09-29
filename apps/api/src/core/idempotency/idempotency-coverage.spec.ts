import 'reflect-metadata';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Permission } from '@dentalcare/shared';
import { PERMISSIONS_METADATA_KEY } from '@/core/authz/permissions.decorator';
import { IDEMPOTENT_METADATA_KEY } from './idempotency.interceptor';

/**
 * No money moves without an Idempotency-Key (the owner's decision,
 * 2026-09-28).
 *
 * The interceptor requires the key only where @Idempotent() is, so the
 * decision holds exactly as far as the decorator reaches. A money route added
 * next month without it would take money on a double tap again, and nothing
 * would say so. This walks every controller and fails the build instead:
 *
 *   - a clinic mutation guarded by a permission that moves money must be
 *     @Idempotent, unless NOT_MONEY says why it moves none;
 *   - every mutation of the console's subscription billing must be;
 *   - and the full list of routes that require a key is written out below,
 *     so adding or dropping one is a change a reviewer sees.
 */

/** Permissions whose mutations create, reverse or move money, or issue a fiscal document. */
const MONEY: readonly Permission[] = [
  'invoices:write', // issue an invoice, cancel one, bill a treatment plan
  'invoices:delete', // ledger adjustments: credits and write-offs
  'invoices:fiscalize', // registration with the tax authority, cash declarations
  'payments:write',
  'payments:void',
  'expenses:write',
  'expenses:void',
  'drawer:operate', // cash in, cash out, counted
  'drawer:approve', // accepting a variance, force-closing a drawer
  'payroll:manage', // salary payments
  'patients:import', // opening balances
];

/** Mutations behind a money permission that move no money, and why. */
const NOT_MONEY: Readonly<Record<string, string>> = {
  'CashDrawerController.noSale':
    'Records that the drawer was opened without a sale. It carries no amount.',
  'CashDrawerController.startCount':
    'Moves the session into counting. No amount: the count itself is keyed.',
  'CashDrawerController.resumeOpen':
    'Moves the session back out of counting before anything was counted. No amount.',
  'CashDrawerController.setApprovalPin':
    "Sets the manager's own approval PIN. Configuration, not money.",
  'PatientImportController.preview': 'Checks a batch and writes nothing.',
};

/** The console's subscription billing: what the vendor charges clinics. */
const PLATFORM_BILLING = 'PlatformBillingController';

/** Every route that requires an Idempotency-Key. Keep it in step with SECURITY_PROGRAM.md. */
const REQUIRES_KEY = [
  // invoices and the ledger
  'InvoicesController.create',
  'InvoicesController.cancel',
  'InvoicesController.pay',
  'PaymentsController.voidPayment',
  'PlanInvoiceController.generate',
  'PatientLedgerController.adjust',
  // expenses and wages
  'ExpensesController.create',
  'ExpensesController.voidExpense',
  'StaffController.recordSalary',
  // fiscalization
  'InvoiceFiscalController.fiscalize',
  'FiscalSettingsController.deposit',
  'FiscalSettingsController.retry',
  // the cash drawer
  'CashDrawerController.open',
  'CashDrawerController.drop',
  'CashDrawerController.payout',
  'CashDrawerController.addFloat',
  'CashDrawerController.submitCount',
  'CashDrawerController.close',
  'CashDrawerController.approve',
  'CashDrawerController.approveWithPin',
  'CashDrawerController.forceClose',
  // opening balances
  'PatientImportController.commit',
  // the console's subscription billing
  'PlatformBillingController.run',
  'PlatformBillingController.pay',
  'PlatformBillingController.void',
  // not money, but a repeat would message every patient twice
  'WhatsAppController.send',
];

const MODULES_DIR = join(__dirname, '..', '..', 'modules');
const MUTATIONS = new Set<number>([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

interface Route {
  key: string;
  controller: string;
  mutation: boolean;
  permissions: Permission[];
  idempotent: boolean;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function discoverRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of sourceFiles(MODULES_DIR)) {
    const mod = require(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, exported) === undefined) continue;

      const cls = exported as new (...args: never[]) => unknown;
      const classPerms = Reflect.getMetadata(PERMISSIONS_METADATA_KEY, cls) as
        Permission[] | undefined;
      const classIdempotent = Reflect.getMetadata(IDEMPOTENT_METADATA_KEY, cls) as
        boolean | undefined;

      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        if (name === 'constructor') continue;
        const handler = (cls.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          number | undefined;
        if (method === undefined) continue;

        routes.push({
          key: `${cls.name}.${name}`,
          controller: cls.name,
          mutation: MUTATIONS.has(method),
          permissions:
            (Reflect.getMetadata(PERMISSIONS_METADATA_KEY, handler) as
              Permission[] | undefined) ??
            classPerms ??
            [],
          idempotent: Boolean(
            (Reflect.getMetadata(IDEMPOTENT_METADATA_KEY, handler) as
              boolean | undefined) ?? classIdempotent,
          ),
        });
      }
    }
  }
  return routes;
}

const movesMoney = (r: Route) =>
  r.mutation && r.permissions.some((p) => MONEY.includes(p));

describe('Idempotency-Key coverage', () => {
  const routes = discoverRoutes();
  const byKey = new Map(routes.map((r) => [r.key, r]));

  it('finds the controllers at all', () => {
    // A refactor that moves the modules must not turn this into a vacuous pass.
    expect(routes.length).toBeGreaterThan(100);
    expect(
      routes.filter((r) => r.controller === PLATFORM_BILLING && r.mutation),
    ).toHaveLength(3);
  });

  it('requires a key on every clinic mutation that moves money', () => {
    const unmarked = routes
      .filter(movesMoney)
      .filter((r) => !r.idempotent && !(r.key in NOT_MONEY))
      .map((r) => `${r.key} [${r.permissions.join(', ')}]`)
      .sort();

    expect(unmarked).toEqual([]);
  });

  it('requires a key on every mutation of the console billing', () => {
    const unmarked = routes
      .filter((r) => r.controller === PLATFORM_BILLING && r.mutation && !r.idempotent)
      .map((r) => r.key);

    expect(unmarked).toEqual([]);
  });

  it('requires a key on exactly the routes listed', () => {
    const marked = routes.filter((r) => r.idempotent).map((r) => r.key);

    expect(marked.sort()).toEqual([...REQUIRES_KEY].sort());
  });

  it('keeps NOT_MONEY honest', () => {
    // An exemption for a route that has since been removed, marked, or moved
    // off a money permission should drop out rather than imply one.
    const stale = Object.keys(NOT_MONEY)
      .filter((key) => {
        const route = byKey.get(key);
        return !route || route.idempotent || !movesMoney(route);
      })
      .sort();

    expect(stale).toEqual([]);
  });
});
