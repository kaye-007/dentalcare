import { Outlet, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useAuth } from '../lib/auth';

function Logo() {
  return (
    <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden>
      <circle cx="9" cy="9" r="4" fill="var(--teal)" />
      <circle cx="19" cy="9" r="3" fill="var(--teal-300)" />
      <circle cx="14" cy="19" r="3.4" fill="var(--ink)" />
      <line x1="9" y1="9" x2="14" y2="19" stroke="var(--teal)" strokeWidth="1.6" />
      <line x1="19" y1="9" x2="14" y2="19" stroke="var(--teal-300)" strokeWidth="1.6" />
    </svg>
  );
}

export default function Layout() {
  const { admin, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="app">
      <header className="bar">
        <button className="bar__brand" onClick={() => navigate('/')}>
          <Logo />
          <span className="bar__text">
            <span className="bar__name">DentalCare</span>
            <span className="bar__sub">NODE&nbsp;X · Control</span>
          </span>
        </button>
        <div className="bar__right">
          <span className="bar__admin">{admin?.email}</span>
          <button className="iconbtn" onClick={logout} title="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
