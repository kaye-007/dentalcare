import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  CalendarDays,
  Users,
  Stethoscope,
  UserCog,
  ReceiptText,
  Wallet,
  TrendingDown,
  BarChart3,
  Settings,
  Search,
  Bell,
  Plus,
  LogOut,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { initials } from '../lib/format';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  ownerOnly?: boolean;
}
interface NavGroup {
  eyebrow?: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    eyebrow: 'Clinic',
    items: [
      { to: '/reservations', label: 'Reservations', icon: CalendarDays },
      { to: '/patients', label: 'Patients', icon: Users },
      { to: '/treatments', label: 'Treatments', icon: Stethoscope },
      { to: '/staff', label: 'Staff', icon: UserCog, ownerOnly: true },
    ],
  },
  {
    eyebrow: 'Finance',
    items: [
      { to: '/invoices', label: 'Invoices', icon: ReceiptText },
      { to: '/payments', label: 'Payments', icon: Wallet },
      { to: '/expenses', label: 'Expenses', icon: TrendingDown },
    ],
  },
  {
    eyebrow: 'Insights',
    items: [{ to: '/reports', label: 'Reports', icon: BarChart3, ownerOnly: true }],
  },
];

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/reservations': 'Reservations',
  '/patients': 'Patients',
  '/treatments': 'Treatments',
  '/staff': 'Staff',
  '/invoices': 'Invoices',
  '/payments': 'Payments',
  '/expenses': 'Expenses',
  '/reports': 'Reports',
  '/settings': 'Settings',
};

function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 28 28" width={size} height={size} aria-hidden>
      <circle cx="9" cy="9" r="4" fill="var(--teal)" />
      <circle cx="19" cy="9" r="3" fill="var(--teal-300)" />
      <circle cx="14" cy="19" r="3.4" fill="var(--ink)" />
      <line x1="9" y1="9" x2="14" y2="19" stroke="var(--teal)" strokeWidth="1.6" />
      <line x1="19" y1="9" x2="14" y2="19" stroke="var(--teal-300)" strokeWidth="1.6" />
    </svg>
  );
}

export default function AppLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const section = '/' + (location.pathname.split('/')[1] ?? '');
  const title = TITLES[section] ?? 'DentalCare';
  const isOwner = user?.role === 'owner';

  return (
    <div className="shell">
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
            <span className="clinic__label">Clinic workspace</span>
          </span>
        </div>

        <nav className="nav">
          {GROUPS.map((group, gi) => {
            const items = group.items.filter((i) => !i.ownerOnly || isOwner);
            if (items.length === 0) return null;
            return (
              <div className="nav__group" key={gi}>
                {group.eyebrow && <p className="nav__eyebrow">{group.eyebrow}</p>}
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
                      <span>{item.label}</span>
                    </NavLink>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="sidebar__foot">
          {isOwner && (
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `nav__item${isActive ? ' nav__item--active' : ''}`
              }
            >
              <Settings size={18} strokeWidth={2} />
              <span>Settings</span>
            </NavLink>
          )}
          <div className="usercard">
            <span className="usercard__avatar">{initials(user?.fullName ?? '?')}</span>
            <span className="usercard__meta">
              <span className="usercard__name">{user?.fullName}</span>
              <span className="usercard__role">{user?.role}</span>
            </span>
            <button className="iconbtn" onClick={logout} title="Sign out">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__title">
            <h1>{title}</h1>
          </div>
          <div className="topbar__actions">
            <div className="topbar__search">
              <Search size={16} />
              <input placeholder="Search patients, invoices…" />
            </div>
            <button
              className="btn btn--primary btn--sm"
              onClick={() => navigate('/reservations')}
            >
              <Plus size={16} /> New appointment
            </button>
            <button className="iconbtn iconbtn--bell" title="Reminder log"
            onClick={() => navigate('/reservations?view=reminders')}>
            <Bell size={17} />
          </button>
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
