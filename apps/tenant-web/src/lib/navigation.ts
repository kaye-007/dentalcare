/**
 * The app's map: seven destinations, each with the pages that belong to it.
 *
 * The sidebar lists the sections; a section with more than one page the user
 * may open shows those pages as a tab row under the header (SectionNav in
 * AppLayout). Every route that existed before still exists at the same URL —
 * this only decides where it is found.
 *
 * Visibility reads the same permissions and feature switches the API
 * enforces. Hiding is a courtesy, never the boundary.
 */
import {
  BarChart3,
  CalendarDays,
  LayoutDashboard,
  Settings,
  Stethoscope,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { FeatureKey } from '@dentalcare/shared';
import type { Permission } from './permissions';
import type { StringKey } from './strings';

export interface NavPage {
  to: string;
  label: StringKey;
  /** Hidden unless the user holds this permission. */
  permission?: Permission;
  /** Hidden unless the user holds at least one of these. */
  anyPermission?: Permission[];
  /** Hidden unless the clinic has this module switched on. */
  feature?: FeatureKey;
  /** Other path prefixes that belong to this page (detail routes). */
  also?: string[];
}

export interface NavSection {
  key: string;
  label: StringKey;
  icon: LucideIcon;
  pages: NavPage[];
}

export const SECTIONS: NavSection[] = [
  {
    key: 'dashboard',
    label: 'nav.dashboard',
    icon: LayoutDashboard,
    pages: [{ to: '/', label: 'nav.dashboard' }],
  },
  {
    key: 'calendar',
    label: 'nav.calendar',
    icon: CalendarDays,
    pages: [
      { to: '/reservations', label: 'nav.calendar', permission: 'appointments:read' },
      { to: '/messages', label: 'nav.messages', permission: 'reminders:read' },
    ],
  },
  {
    key: 'patients',
    label: 'nav.patients',
    icon: Users,
    pages: [
      { to: '/patients', label: 'nav.allPatients', permission: 'patients:read' },
      { to: '/patients/recall', label: 'nav.recall', permission: 'appointments:read' },
      { to: '/patients/import', label: 'nav.import', permission: 'patients:import' },
    ],
  },
  {
    key: 'clinical',
    label: 'nav.clinical',
    icon: Stethoscope,
    pages: [
      { to: '/clinical', label: 'nav.clinicalToday', permission: 'clinical:read' },
      { to: '/lab', label: 'nav.lab', permission: 'lab:read' },
      { to: '/treatments', label: 'nav.treatments', permission: 'treatments:read' },
      { to: '/inventory', label: 'nav.inventory', permission: 'inventory:read' },
    ],
  },
  {
    key: 'payments',
    label: 'nav.payments',
    icon: Wallet,
    pages: [
      { to: '/invoices', label: 'nav.invoices', permission: 'invoices:read' },
      { to: '/payments', label: 'nav.payments', permission: 'payments:read' },
      {
        to: '/drawer',
        label: 'nav.drawer',
        anyPermission: ['drawer:operate', 'drawer:read'],
        feature: 'cash_drawer',
      },
      { to: '/expenses', label: 'nav.expenses', permission: 'expenses:read' },
      { to: '/fiscal-queue', label: 'nav.fiscalQueue', permission: 'fiscal:read' },
    ],
  },
  {
    key: 'reports',
    label: 'nav.reports',
    icon: BarChart3,
    pages: [
      { to: '/financials', label: 'nav.financials', permission: 'reports:read' },
      { to: '/reports', label: 'nav.reports', permission: 'reports:read' },
      { to: '/activity', label: 'nav.activity', permission: 'audit:read' },
    ],
  },
  {
    key: 'settings',
    label: 'nav.settings',
    icon: Settings,
    pages: [
      { to: '/settings', label: 'nav.clinicSettings', permission: 'settings:manage' },
      { to: '/staff', label: 'nav.staff', permission: 'staff:manage' },
      { to: '/rooms', label: 'nav.rooms', permission: 'appointments:read' },
    ],
  },
];

type Can = (p: Permission) => boolean;
type Enabled = (f: FeatureKey) => boolean;

export function pageVisible(p: NavPage, can: Can, enabled: Enabled): boolean {
  return (
    (!p.permission || can(p.permission)) &&
    (!p.anyPermission || p.anyPermission.some((x) => can(x))) &&
    (!p.feature || enabled(p.feature))
  );
}

export function visiblePages(s: NavSection, can: Can, enabled: Enabled): NavPage[] {
  return s.pages.filter((p) => pageVisible(p, can, enabled));
}

/** Does `pathname` sit on this page or one of its detail routes? */
function onPage(p: NavPage, pathname: string): boolean {
  if (p.to === '/') return pathname === '/';
  return [p.to, ...(p.also ?? [])].some(
    (base) => pathname === base || pathname.startsWith(`${base}/`),
  );
}

/**
 * The page the path belongs to — the most specific match, so /patients/import
 * is the Import page rather than "some patient".
 */
export function locate(pathname: string): { section: NavSection; page: NavPage } | null {
  let best: { section: NavSection; page: NavPage } | null = null;
  for (const section of SECTIONS) {
    for (const page of section.pages) {
      if (onPage(page, pathname) && (!best || page.to.length > best.page.to.length)) {
        best = { section, page };
      }
    }
  }
  return best;
}

/** True on a page itself, false on a detail route under it (/invoices/123). */
export function isTopLevel(pathname: string, page: NavPage): boolean {
  return pathname.replace(/\/$/, '') === page.to || (page.to === '/' && pathname === '/');
}
