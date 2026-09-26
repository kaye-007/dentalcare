import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  Building2,
  ChevronRight,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Receipt,
  Search,
  Tag,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { Avatar } from './ui';
import { ShellCtx, type Shell } from './shell';
import CommandPalette from './CommandPalette';
import CreateClinicWizard from './CreateClinicWizard';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  badge?: 'clinics' | 'overdue';
}

/** Who the clinics are, what they owe, what they use — and what was done. */
const GROUPS: { eyebrow?: string; items: NavItem[] }[] = [
  { items: [{ to: '/', label: 'Overview', icon: LayoutDashboard, end: true }] },
  {
    eyebrow: 'Fleet',
    items: [
      { to: '/clinics', label: 'Clinics', icon: Building2, badge: 'clinics' },
      { to: '/usage', label: 'Usage', icon: HardDrive },
    ],
  },
  {
    eyebrow: 'Revenue',
    items: [
      { to: '/billing', label: 'Billing', icon: Receipt, badge: 'overdue' },
      { to: '/plans', label: 'Plans', icon: Tag },
    ],
  },
  { eyebrow: 'Audit', items: [{ to: '/activity', label: 'Activity', icon: Activity }] },
];

const SECTIONS: [RegExp, string, string?][] = [
  [/^\/$/, 'Overview'],
  [/^\/clinics/, 'Clinics'],
  [/^\/tenants\//, 'Clinics', '/clinics'],
  [/^\/billing/, 'Billing'],
  [/^\/plans/, 'Plans'],
  [/^\/usage/, 'Usage'],
  [/^\/activity/, 'Activity'],
];

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 28 28" width={size} height={size} aria-hidden>
      <line x1="9" y1="9" x2="14" y2="19" stroke="var(--logo-1)" strokeWidth="1.6" />
      <line x1="19" y1="9" x2="14" y2="19" stroke="var(--logo-2)" strokeWidth="1.6" />
      <circle cx="9" cy="9" r="4" fill="var(--logo-1)" />
      <circle cx="19" cy="9" r="3" fill="var(--logo-2)" />
      <circle cx="14" cy="19" r="3.4" fill="var(--logo-3)" />
    </svg>
  );
}

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export default function Layout() {
  const { admin, logout } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [creating, setCreating] = useState<'clinic' | 'demo' | null>(null);
  const [crumb, setCrumb] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [badges, setBadges] = useState<{ clinics?: number; overdue?: number }>({});

  const refreshBadges = useCallback(() => {
    Promise.all([api.overview(), api.billingSummary()])
      .then(([o, b]) =>
        setBadges({
          clinics: o.clinics.active + o.clinics.suspended + o.clinics.archived,
          overdue: b.overdueCount,
        }),
      )
      .catch(() => undefined);
  }, []);
  useEffect(refreshBadges, [refreshBadges]);

  // The drawer is a phone affordance; any navigation closes it.
  useEffect(() => setNavOpen(false), [location.pathname]);

  const openPalette = useCallback(() => setPalette(true), []);
  const closePalette = useCallback(() => setPalette(false), []);
  const openCreate = useCallback(
    (demo = false) => setCreating(demo ? 'demo' : 'clinic'),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [section, sectionLink] = useMemo(() => {
    const hit = SECTIONS.find(([re]) => re.test(location.pathname));
    return [hit?.[1] ?? 'Control', hit?.[2]];
  }, [location.pathname]);

  useEffect(() => {
    document.title = `${crumb ?? section} · NODE X Control`;
  }, [crumb, section]);

  const shell = useMemo<Shell>(
    () => ({ openCreate, openPalette, setCrumb, refreshBadges, version }),
    [openCreate, openPalette, refreshBadges, version],
  );

  return (
    <ShellCtx.Provider value={shell}>
      <div className={`shell${navOpen ? ' shell--navopen' : ''}`}>
        <a className="skiplink" href="#content">
          Skip to content
        </a>

        <aside className="sidebar" aria-label="Console">
          <div className="sidebar__top">
            <Link to="/" className="brand">
              <span className="brand__mark">
                <Logo />
              </span>
              <span className="brand__meta">
                <span className="brand__name">DentalCare</span>
                <span className="brand__label">NODE X · Control</span>
              </span>
            </Link>
            <button
              type="button"
              className="iconbtn iconbtn--quiet sidebar__close"
              onClick={() => setNavOpen(false)}
              aria-label="Close menu"
            >
              <X size={18} />
            </button>
          </div>

          <button type="button" className="sidebar__search" onClick={openPalette}>
            <Search size={15} aria-hidden />
            <span>Jump to…</span>
            <kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd>
          </button>

          <nav className="nav">
            {GROUPS.map((g, gi) => (
              <div className="nav__group" key={gi}>
                {g.eyebrow && <p className="nav__eyebrow">{g.eyebrow}</p>}
                {g.items.map((n) => {
                  const count = n.badge ? badges[n.badge] : undefined;
                  return (
                    <NavLink
                      key={n.to}
                      to={n.to}
                      end={n.end}
                      className={({ isActive }) =>
                        `nav__item${isActive || (n.to === '/clinics' && location.pathname.startsWith('/tenants/')) ? ' nav__item--active' : ''}`
                      }
                    >
                      <n.icon size={17} aria-hidden />
                      {n.label}
                      {count !== undefined && count > 0 && (
                        <span
                          className={`nav__badge${n.badge === 'overdue' ? ' nav__badge--alert' : ''}`}
                          aria-label={
                            n.badge === 'overdue'
                              ? `${count} overdue`
                              : `${count} clinics`
                          }
                        >
                          {count}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="sidebar__foot">
            <div className="usercard">
              <Avatar name={admin?.fullName || admin?.email || '?'} size={34} />
              <span className="usercard__meta">
                <span className="usercard__name">
                  {admin?.fullName || 'Administrator'}
                </span>
                <span className="usercard__role">{admin?.email}</span>
              </span>
              <button
                type="button"
                className="iconbtn iconbtn--quiet"
                onClick={logout}
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </aside>
        <button
          type="button"
          className="scrim"
          aria-hidden
          tabIndex={-1}
          onClick={() => setNavOpen(false)}
        />

        <div className="main">
          <header className="topbar">
            <div className="topbar__lead">
              <button
                type="button"
                className="iconbtn iconbtn--quiet navtoggle"
                onClick={() => setNavOpen(true)}
                aria-label="Open menu"
              >
                <Menu size={19} />
              </button>
              <ol className="crumbs" aria-label="You are here">
                <li className="crumbs__root">NODE X Control</li>
                <li aria-hidden className="crumbs__sep">
                  <ChevronRight size={14} />
                </li>
                {crumb ? (
                  <>
                    <li>
                      <Link className="crumbs__link" to={sectionLink ?? '/'}>
                        {section}
                      </Link>
                    </li>
                    <li aria-hidden className="crumbs__sep">
                      <ChevronRight size={14} />
                    </li>
                    <li className="crumbs__here" aria-current="page">
                      {crumb}
                    </li>
                  </>
                ) : (
                  <li className="crumbs__here" aria-current="page">
                    {section}
                  </li>
                )}
              </ol>
            </div>
            <div className="topbar__actions">
              <button
                type="button"
                className="topsearch"
                onClick={openPalette}
                aria-label="Search clinics"
              >
                <Search size={15} aria-hidden />
                <span>Search clinics…</span>
                <kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd>
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => openCreate(false)}
              >
                <Plus size={16} aria-hidden />
                <span className="topbar__label">New clinic</span>
              </button>
            </div>
          </header>

          <main className="content" id="content" tabIndex={-1}>
            <Outlet />
          </main>
        </div>

        {palette && <CommandPalette onClose={closePalette} onCreate={openCreate} />}
        {creating && (
          <CreateClinicWizard
            demo={creating === 'demo'}
            onClose={() => setCreating(null)}
            onCreated={() => {
              setVersion((v) => v + 1);
              refreshBadges();
            }}
          />
        )}
      </div>
    </ShellCtx.Provider>
  );
}
