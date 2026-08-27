import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3, Bell, CalendarDays, Clock, DoorOpen, History, LayoutDashboard, Lock, LogOut, Menu, Plus, ReceiptText, Settings, Stethoscope, TrendingDown, UserCog, Users, Wallet,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { initials } from '../lib/format';
import { type Permission } from '../lib/permissions';
import { useT, type MessageKey } from '../lib/i18n';
import { dateLocale } from '../lib/i18n';

interface NavItem {
  to: string;
  /** A dictionary key, not a string — the sidebar is fully translated. */
  label: MessageKey;
  icon: typeof LayoutDashboard;
  /** Hidden unless the signed-in user holds this permission. */
  permission?: Permission;
}
interface NavGroup {
  eyebrow?: MessageKey;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  { items: [{ to: '/', label: 'nav.dashboard', icon: LayoutDashboard }] },
  {
    eyebrow: 'nav.group.clinic',
    items: [
      { to: '/reservations', label: 'nav.reservations', icon: CalendarDays },
      { to: '/patients', label: 'nav.patients', icon: Users },
      { to: '/treatments', label: 'nav.treatments', icon: Stethoscope },
      { to: '/staff', label: 'nav.staff', icon: UserCog, permission: 'staff:manage' },
      { to: '/rooms', label: 'nav.rooms', icon: DoorOpen },
    ],
  },
  {
    eyebrow: 'nav.group.finance',
    items: [
      { to: '/invoices', label: 'nav.invoices', icon: ReceiptText, permission: 'invoices:read' },
      { to: '/payments', label: 'nav.payments', icon: Wallet, permission: 'payments:read' },
      { to: '/expenses', label: 'nav.expenses', icon: TrendingDown, permission: 'expenses:read' },
    ],
  },
  {
    eyebrow: 'nav.group.insights',
    items: [
      { to: '/financials', label: 'nav.financials', icon: BarChart3, permission: 'reports:read' },
      { to: '/reports', label: 'nav.reports', icon: BarChart3, permission: 'reports:read' },
      { to: '/activity', label: 'nav.activity', icon: History, permission: 'audit:read' },
    ],
  },
];

const TITLES: Record<string, MessageKey> = {
  '/': 'nav.dashboard',
  '/reservations': 'nav.reservations',
  '/patients': 'nav.patients',
  '/treatments': 'nav.treatments',
  '/staff': 'nav.staff',
  '/invoices': 'nav.invoices',
  '/payments': 'nav.payments',
  '/expenses': 'nav.expenses',
  '/rooms': 'nav.rooms',
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
function TrialBanner({
  readOnly,
  endsAt,
}: {
  readOnly: boolean;
  endsAt: string | null;
}) {
  if (!endsAt) return null;

  const date = new Date(endsAt);
  const pretty = date.toLocaleDateString(dateLocale(), {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  if (readOnly) {
    return (
      <div className="trialbar trialbar--ended" role="status">
        <Lock size={15} />
        <span>
          <strong>Your trial ended</strong> on {pretty}. Everything you entered
          is still here — subscribe to start adding again.
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
          {daysLeft <= 1 ? 'Your trial ends today' : `${daysLeft} days left in your trial`}
        </strong>
        {daysLeft <= 1 ? '' : ` — it runs until ${pretty}`}. After that the
        clinic stays readable but you cannot add anything new.
      </span>
    </div>
  );
}

export default function AppLayout() {
  const { user, logout, can, readOnly, trialEndsAt } = useAuth();
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const section = '/' + (location.pathname.split('/')[1] ?? '');
  const titleKey = TITLES[section];
  const title = titleKey ? t(titleKey) : 'DentalCare';


  // Close the mobile drawer whenever the route changes, so tapping a
  // destination doesn't leave the menu covering the page it just opened.
  useEffect(() => setNavOpen(false), [location.pathname]);

  // Escape closes it, matching the modal behaviour elsewhere.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <div className={`shell${navOpen ? ' shell--navopen' : ''}`}>
      <button
        className="scrim"
        aria-label={t('nav.close')}
        tabIndex={navOpen ? 0 : -1}
        onClick={() => setNavOpen(false)}
      />
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark"><Logo /></span>
          <span className="brand__text">
            <span className="brand__name">DentalCare</span>
            <span className="brand__by">NODE X</span>
          </span>
        </div>

        <div className="clinic">
          <span className="clinic__dot" aria-hidden />
          <span className="clinic__meta">
            <span className="clinic__name">{user?.clinicName ?? 'Clinic'}</span>
            <span className="clinic__label">{t('nav.workspace')}</span>
          </span>
        </div>

        <nav className="nav">
          {GROUPS.map((group, gi) => {
            const items = group.items.filter((i) => !i.permission || can(i.permission));
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
                      <Icon size={18} strokeWidth={2} />
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
              <Settings size={18} strokeWidth={2} />
              <span>{t('nav.settings')}</span>
            </NavLink>
          )}
          <div className="usercard">
            <span className="usercard__avatar">{initials(user?.fullName ?? '?')}</span>
            <span className="usercard__meta">
              <span className="usercard__name">{user?.fullName}</span>
              <span className="usercard__role">{user ? t(`role.${user.role}`) : ''}</span>
            </span>
            <button className="iconbtn" onClick={logout} title={t('nav.logout')} aria-label={t('nav.logout')}>
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__title">
            <button
              className="iconbtn navtoggle"
              aria-label={t('nav.open')}
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <Menu size={18} />
            </button>
            <h1>{title}</h1>
          </div>
          <div className="topbar__actions">
            {!readOnly && (
            <button
              className="btn btn--primary btn--sm"
              onClick={() => navigate('/reservations')}
            >
              <Plus size={16} /> {t('quick.newAppointment')}
            </button>
            )}
            <button
              className="iconbtn iconbtn--bell"
              title={t('nav.reminderLog')}
              aria-label={t('nav.reminderLog')}
              onClick={() => navigate('/reservations?view=reminders')}
            >
              <Bell size={17} />
            </button>
          </div>
        </header>
        <TrialBanner readOnly={readOnly} endsAt={trialEndsAt} />
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
