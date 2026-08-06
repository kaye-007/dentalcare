import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from =
    (location.state as { from?: { pathname: string } } | null)?.from?.pathname ??
    '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="auth__brand">
          <svg viewBox="0 0 28 28" width="34" height="34" aria-hidden>
            <circle cx="9" cy="9" r="4" fill="var(--teal)" />
            <circle cx="19" cy="9" r="3" fill="var(--teal-300)" />
            <circle cx="14" cy="19" r="3.4" fill="var(--ink)" />
            <line x1="9" y1="9" x2="14" y2="19" stroke="var(--teal)" strokeWidth="1.6" />
            <line x1="19" y1="9" x2="14" y2="19" stroke="var(--teal-300)" strokeWidth="1.6" />
          </svg>
          <div>
            <p className="auth__name">DentalCare</p>
            <p className="auth__by">by NODE X</p>
          </div>
        </div>

        <h1 className="auth__title">Sign in to your clinic</h1>
        <p className="auth__sub">Manage patients, appointments, and billing.</p>

        <form className="auth__form" onSubmit={onSubmit}>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@clinic.com"
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </label>

          {error && <p className="auth__error">{error}</p>}

          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {import.meta.env.DEV && (
          <div className="auth__hint">
            <p>Demo logins</p>
            <code>demo@dentx.app · Demo@2026!</code>
            <code>m.novak@dentx.app · Demo@2026!</code>
          </div>
        )}
      </div>
    </div>
  );
}
