import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="auth__brand">
          <svg viewBox="0 0 28 28" width="32" height="32" aria-hidden>
            <circle cx="9" cy="9" r="4" fill="var(--teal)" />
            <circle cx="19" cy="9" r="3" fill="var(--teal-300)" />
            <circle cx="14" cy="19" r="3.4" fill="var(--ink)" />
            <line x1="9" y1="9" x2="14" y2="19" stroke="var(--teal)" strokeWidth="1.6" />
            <line x1="19" y1="9" x2="14" y2="19" stroke="var(--teal-300)" strokeWidth="1.6" />
          </svg>
          <div>
            <p className="auth__name">DentalCare</p>
            <p className="auth__by">NODE X · Control</p>
          </div>
        </div>
        <h1 className="auth__title">Platform administration</h1>
        <p className="auth__sub">Manage clinics, plans, and access.</p>
        <form className="auth__form" onSubmit={submit}>
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@nodex.al" autoComplete="username" required />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••" autoComplete="current-password" required />
          </label>
          {error && <p className="auth__error">{error}</p>}
          <button className="btn btn--primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="auth__hint">
          <p>Demo superadmin</p>
          <code>admin@nodex.al · Admin123!</code>
        </div>
      </div>
    </div>
  );
}
