import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Banknote,
  BarChart3,
  Landmark,
  BellRing,
  CalendarDays,
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  Clock,
  DoorOpen,
  History,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  MessageCircle,
  Package,
  PieChart,
  Plus,
  ReceiptText,
  Search,
  Settings,
  Stethoscope,
  TrendingDown,
  UserCog,
  UserPlus,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api, type PatientListItem } from '../lib/api';
import { type Permission } from '../lib/permissions';
import { t, type StringKey } from '../lib/strings';
import { dateLocale } from '../lib/strings';
import { Avatar, StatusPill } from './ui';
import { AccountSecurityButton } from './AccountSecurityModal';
import DrawerChip from './drawer/DrawerChip';
import { useFeatures } from '../lib/features';
import type { FeatureKey } from '@dentalcare/shared';

interface NavItem {
  to: string;
  /** A dictionary key, not a string — the sidebar is fully translated. */
  label: StringKey;
  icon: typeof LayoutDashboard;
  /** Hidden unless the signed-in user holds this permission. */
  permission?: Permission;
  /** Hidden unless the user holds at least one of these. */
  anyPermission?: Permission[];
  /** Hidden unless the clinic has this module switched on. */
  feature?: FeatureKey;
}
interface NavGroup {
  eyebrow?: StringKey;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  { items: [{ to: '/', label: 'nav.dashboard', icon: LayoutDashboard }] },
  {
    eyebrow: 'nav.group.clinic',
    items: [
      { to: '/reservations', label: 'nav.reservations', icon: CalendarDays },
      { to: '/messages', label: 'nav.messages', icon: MessageCircle, permission: 'reminders:read' },
      { to: '/patients', label: 'nav.patients', icon: Users },
      { to: '/treatments', label: 'nav.treatments', icon: Stethoscope },
      { to: '/staff', label: 'nav.staff', icon: UserCog, permission: 'staff:manage' },
      { to: '/rooms', label: 'nav.rooms', icon: DoorOpen },
      {
        to: '/inventory',
        label: 'nav.inventory',
        icon: Package,
        permission: 'inventory:read',
      },
    ],
  },
  {
    eyebrow: 'nav.group.finance',
    items: [
      {
        to: '/invoices',
        label: 'nav.invoices',
        icon: ReceiptText,
        permission: 'invoices:read',
      },
      {
        to: '/payments',
        label: 'nav.payments',
        icon: Wallet,
        permission: 'payments:read',
      },
      {
        to: '/drawer',
        label: 'nav.drawer',
        icon: Banknote,
        anyPermission: ['drawer:operate', 'drawer:read'],
        feature: 'cash_drawer',
      },
      {
        to: '/fiscal-queue',
        label: 'nav.fiscalQueue',
        icon: Landmark,
        permission: 'fiscal:read',
      },
      {
        to: '/expenses',
        label: 'nav.expenses',
        icon: TrendingDown,
        permission: 'expenses:read',
      },
    ],
  },
  {
    eyebrow: 'nav.group.insights',
    items: [
      {
        to: '/financials',
        label: 'nav.financials',
        icon: PieChart,
        permission: 'reports:read',
      },
      {
        to: '/reports',
        label: 'nav.reports',
        icon: BarChart3,
        permission: 'reports:read',
      },
      { to: '/activity', label: 'nav.activity', icon: History, permission: 'audit:read' },
    ],
  },
];

const TITLES: Record<string, StringKey> = {
  '/': 'nav.dashboard',
  '/reservations': 'nav.reservations',
  '/messages': 'nav.messages',
  '/patients': 'nav.patients',
  '/treatments': 'nav.treatments',
  '/staff': 'nav.staff',
  '/invoices': 'nav.invoices',
  '/payments': 'nav.payments',
  '/drawer': 'nav.drawer',
  '/fiscal-queue': 'nav.fiscalQueue',
  '/expenses': 'nav.expenses',
  '/rooms': 'nav.rooms',
  '/inventory': 'nav.inventory',
  '/financials': 'nav.financials',
  '/reports': 'nav.reports',
  '/activity': 'nav.activity',
  '/settings': 'nav.settings',
};

function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 28 28" width={size} height={size} aria-hidden>
      <circle cx="9" cy="9" r="4" fill="var(--logo-1)" />
      <circle cx="19" cy="9" r="3" fill="var(--logo-2)" />
      <circle cx="14" cy="19" r="3.4" fill="var(--logo-3)" />
      <line x1="9" y1="9" x2="14" y2="19" stroke="var(--logo-1)" strokeWidth="1.6" />
      <line x1="19" y1="9" x2="14" y2="19" stroke="var(--logo-2)" strokeWidth="1.6" />
    </svg>
  );
}

/** How much notice a clinic gets before the lock, in days. */
const TRIAL_WARNING_DAYS = 3;

/**
 * One bar, two states.
 *
 * Going from writable to read-only with no warning is the version of this
 * that makes people angry rather than making them buy: the first they learn
 * of it is a button that stopped working mid-task. So the last few days say
 * so, in a colour that reads as information rather than alarm, and only the
 * expiry itself is amber.
 */
function TrialBanner({ readOnly, endsAt }: { readOnly: boolean; endsAt: string | null }) {
  if (!endsAt) return null;

  const date = new Date(endsAt);
  const pretty = date.toLocaleDateString(dateLocale(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  if (readOnly) {
    return (
      <div className="trialbar trialbar--ended" role="status">
        <Lock size={15} />
        <span>
          <strong>Your trial ended</strong> on {pretty}. Everything you entered is still
          here — subscribe to start adding again.
        </span>
      </div>
    );
  }

  // Ceil, so the final partial day reads "1 day left" rather than "0".
  const daysLeft = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  if (daysLeft > TRIAL_WARNING_DAYS) return null;

  return (
    <div className="trialbar trialbar--ending" role="status">
      <Clock size={15} />
      <span>
        <strong>
          {daysLeft <= 1
            ? 'Your trial ends today'
            : `${daysLeft} days left in your trial`}
        </strong>
        {daysLeft <= 1 ? '' : ` — it runs until ${pretty}`}. After that the clinic stays
        readable but you cannot add anything new.
      </span>
    </div>
  );
}

/* ── patient search ─────────────────────────────────────────
   The front desk's most frequent lookup, one keystroke away on every page.
   It is the same search the patient list runs, so what it finds is what the
   list would find; "See all results" hands the term over to that list. */
const MIN_SEARCH = 2;

function PatientSearch() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PatientListItem[] | null>(null);
  const [active, setActive] = useState(0);

  // "/" jumps to search from anywhere that is not already a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_SEARCH) {
      setResults(null);
      return;
    }
    // A slower response for an older term must not overwrite a newer one.
    let stale = false;
    const timer = window.setTimeout(() => {
      api
        .listPatients({ q: term, status: 'all' })
        .then((d) => {
          if (stale) return;
          setResults(d.items.slice(0, 6));
          setActive(0);
        })
        .catch(() => {
          if (!stale) setResults([]);
        });
    }, 200);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [q]);

  const term = q.trim();
  const showList = open && term.length >= MIN_SEARCH;
  const options = results ?? [];
  // The patients, then "See all results".
  const optionCount = options.length + 1;
  const seeAll = `/patients?q=${encodeURIComponent(term)}`;

  const go = (to: string) => {
    setOpen(false);
    setQ('');
    setResults(null);
    inputRef.current?.blur();
    navigate(to);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      e.currentTarget.blur();
      return;
    }
    if (term.length < MIN_SEARCH) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % optionCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + optionCount) % optionCount);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = options[active];
      go(picked ? `/patients/${picked.id}` : seeAll);
    }
  };

  return (
    <div className="gsearch" role="search">
      <label className="gsearch__box">
        <Search size={16} aria-hidden />
        <span className="sr-only">Search patients</span>
        <input
          ref={inputRef}
          type="search"
          value={q}
          placeholder="Search patients by name, phone or email…"
          autoComplete="off"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        <kbd className="gsearch__kbd" aria-hidden>
          /
        </kbd>
      </label>

      {showList && (
        <ul className="gsearch__list" id={listId} role="listbox" aria-label="Matching patients">
          {results === null && (
            <li className="gsearch__status" role="presentation">
              Searching…
            </li>
          )}
          {results !== null && options.length === 0 && (
            <li className="gsearch__status" role="presentation">
              No patients match “{term}”
            </li>
          )}
          {options.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`gsearch__option${i === active ? ' gsearch__option--active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(`/patients/${p.id}`)}
            >
              <Avatar name={`${p.firstName} ${p.lastName}`} size={30} />
              <span className="gsearch__meta">
                <span className="gsearch__name">
                  {p.firstName} {p.lastName}
                </span>
                <span className="gsearch__sub">
                  {[p.phone, p.city].filter(Boolean).join(' · ') || p.email || '—'}
                </span>
              </span>
              {p.status !== 'active' && <StatusPill status={p.status} />}
            </li>
          ))}
          <li
            id={`${listId}-${options.length}`}
            role="option"
            aria-selected={active === options.length}
            className={`gsearch__option gsearch__option--all${
              active === options.length ? ' gsearch__option--active' : ''
            }`}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(options.length)}
            onClick={() => go(seeAll)}
          >
            <Search size={15} aria-hidden /> See all results for “{term}”
          </li>
        </ul>
      )}
    </div>
  );
}

/* ── create menu ────────────────────────────────────────────
   Every "new" the signed-in user is allowed to make, from any page. Items
   the role cannot create are left out rather than shown disabled, and the
   whole menu goes when the trial is read-only. */
function NewMenu() {
  const { can, readOnly } = useAuth();
  const location = useLocation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);

  const items = [
    {
      to: '/reservations?new=1',
      label: t('quick.newAppointment'),
      icon: CalendarPlus,
      allowed: can('appointments:write'),
    },
    {
      to: '/patients/new',
      label: t('quick.addPatient'),
      icon: UserPlus,
      allowed: can('patients:write'),
    },
    {
      to: '/invoices?new=1',
      label: t('quick.newInvoice'),
      icon: ReceiptText,
      allowed: can('invoices:write'),
    },
    {
      to: '/expenses?new=1',
      label: t('quick.addExpense'),
      icon: TrendingDown,
      allowed: can('expenses:write'),
    },
  ].filter((i) => i.allowed);

  useEffect(() => setOpen(false), [location.pathname, location.search]);

  useEffect(() => {
    if (!open) return;
    wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (readOnly || items.length === 0) return null;

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const els = Array.from(
      wrapRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      els[(i + 1) % els.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      els[(i - 1 + els.length) % els.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="newmenu" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn--ghost btn--sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Create new"
        onClick={() => setOpen((o) => !o)}
      >
        <Plus size={16} aria-hidden />
        <span className="topbar__label">New</span>
        <ChevronDown className="newmenu__caret" size={15} aria-hidden />
      </button>
      {open && (
        <div
          className="newmenu__list"
          id={menuId}
          role="menu"
          aria-label="Create new"
          onKeyDown={onMenuKey}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                role="menuitem"
                className="newmenu__item"
                onClick={() => setOpen(false)}
              >
                <span className="quick__icon" aria-hidden>
                  <Icon size={16} />
                </span>
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function AppLayout() {
  const { user, logout, can, readOnly, trialEndsAt } = useAuth();
  const { enabled } = useFeatures();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const section = '/' + (location.pathname.split('/')[1] ?? '');
  const titleKey = TITLES[section];
  const title = titleKey ? t(titleKey) : 'DentalCare';
  // On /patients/123 the section crumb is the way back to the list.
  const nested = section !== '/' && location.pathname.replace(/\/$/, '') !== section;
  const clinicName = user?.clinicName ?? 'Clinic';

  // Close the mobile drawer whenever the route changes, so tapping a
  // destination doesn't leave the menu covering the page it just opened.
  useEffect(() => setNavOpen(false), [location.pathname]);

  // Escape closes it, matching the dialogs elsewhere.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  // Focus follows the drawer: into it on open, back to the menu button on
  // close — otherwise a keyboard user is left on a control that just vanished.
  useEffect(() => {
    if (navOpen) {
      wasOpen.current = true;
      closeRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      toggleRef.current?.focus();
    }
  }, [navOpen]);

  return (
    <div className={`shell${navOpen ? ' shell--navopen' : ''}`}>
      <a className="skiplink" href="#main">
        Skip to content
      </a>
      <button
        className="scrim"
        aria-label={t('nav.close')}
        tabIndex={navOpen ? 0 : -1}
        onClick={() => setNavOpen(false)}
      />
      <aside className="sidebar" id="app-sidebar" aria-label="Sidebar">
        <div className="sidebar__top">
          <div className="clinic">
            <span className="clinic__mark">
              <Logo size={22} />
            </span>
            <span className="clinic__meta">
              <span className="clinic__name" title={clinicName}>
                {clinicName}
              </span>
              <span className="clinic__label">DentalCare</span>
            </span>
          </div>
          <button
            ref={closeRef}
            className="iconbtn iconbtn--quiet sidebar__close"
            aria-label={t('nav.close')}
            onClick={() => setNavOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <nav className="nav" aria-label="Main">
          {GROUPS.map((group, gi) => {
            const items = group.items.filter(
              (i) =>
                (!i.permission || can(i.permission)) &&
                (!i.anyPermission || i.anyPermission.some((p) => can(p))) &&
                (!i.feature || enabled(i.feature)),
            );
            if (items.length === 0) return null;
            return (
              <div className="nav__group" key={gi}>
                {group.eyebrow && <p className="nav__eyebrow">{t(group.eyebrow)}</p>}
                {items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      className={({ isActive }) =>
                        `nav__item${isActive ? ' nav__item--active' : ''}`
                      }
                    >
                      <Icon size={18} strokeWidth={1.9} aria-hidden />
                      <span>{t(item.label)}</span>
                    </NavLink>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="sidebar__foot">
          {can('settings:manage') && (
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `nav__item${isActive ? ' nav__item--active' : ''}`
              }
            >
              <Settings size={18} strokeWidth={1.9} aria-hidden />
              <span>{t('nav.settings')}</span>
            </NavLink>
          )}
          <div className="usercard">
            <Avatar name={user?.fullName ?? '?'} size={34} />
            <span className="usercard__meta">
              <span className="usercard__name">{user?.fullName}</span>
              <span className="usercard__role">{user ? t(`role.${user.role}`) : ''}</span>
            </span>
            <AccountSecurityButton />
            <button
              className="iconbtn iconbtn--quiet"
              onClick={logout}
              title={t('nav.logout')}
              aria-label={t('nav.logout')}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__lead">
            <button
              ref={toggleRef}
              className="iconbtn navtoggle"
              aria-label={t('nav.open')}
              aria-expanded={navOpen}
              aria-controls="app-sidebar"
              onClick={() => setNavOpen(true)}
            >
              <Menu size={18} />
            </button>
            <nav aria-label="Breadcrumb">
              <ol className="crumbs">
                <li>
                  <span className="crumbs__clinic">{clinicName}</span>
                  <ChevronRight className="crumbs__sep" size={14} aria-hidden />
                </li>
                <li>
                  {nested ? (
                    <Link to={section} className="crumbs__here">
                      {title}
                    </Link>
                  ) : (
                    <span className="crumbs__here" aria-current="page">
                      {title}
                    </span>
                  )}
                </li>
              </ol>
            </nav>
          </div>

          <PatientSearch />

          <div className="topbar__actions">
            {/* On a phone the search box does not fit; the patient list,
                which has the same search, is one tap away instead. */}
            <Link
              to="/patients"
              className="iconbtn topbar__searchlink"
              aria-label="Search patients"
              title="Search patients"
            >
              <Search size={17} aria-hidden />
            </Link>
            <DrawerChip />
            {!readOnly && <NewMenu />}
            {can('reminders:read') && (
              <Link to="/messages" className="iconbtn" title={t('nav.messages')} aria-label={t('nav.messages')}>
                <MessageCircle size={17} aria-hidden />
              </Link>
            )}
            <Link
              to="/reservations?view=reminders"
              className="iconbtn"
              title={t('nav.reminderLog')}
              aria-label={t('nav.reminderLog')}
            >
              <BellRing size={17} aria-hidden />
            </Link>
          </div>
        </header>
        <TrialBanner readOnly={readOnly} endsAt={trialEndsAt} />
        <main className="content" id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
