import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { useT } from '../lib/i18n';
import LanguageToggle from '../components/LanguageToggle';
import GoogleButton from '../components/GoogleButton';

export default function LoginPage() {
  const { login } = useAuth();
  const t = useT();
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
      setError(err instanceof ApiError ? err.message : t('login.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="auth__top">
          <LanguageToggle size="sm" />
        </div>

        <div className="auth__brand">
          <svg viewBox="0 0 28 28" width="34" height="34" aria-hidden>
            <circle cx="9" cy="9" r="4" fill="var(--logo-1)" />
            <circle cx="19" cy="9" r="3" fill="var(--logo-2)" />
            <circle cx="14" cy="19" r="3.4" fill="var(--logo-3)" />
            <line x1="9" y1="9" x2="14" y2="19" stroke="var(--logo-1)" strokeWidth="1.6" />
            <line x1="19" y1="9" x2="14" y2="19" stroke="var(--logo-2)" strokeWidth="1.6" />
          </svg>
          <div>
            <p className="auth__name">DentalCare</p>
            <p className="auth__by">by NODE X</p>
          </div>
        </div>

        <h1 className="auth__title">{t('login.title')}</h1>
        <p className="auth__sub">{t('login.subtitle')}</p>

        <form className="auth__form" onSubmit={onSubmit}>
          <label className="field">
            <span>{t('login.email')}</span>
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
            <span>{t('login.password')}</span>
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
            {busy ? t('login.submitting') : t('login.submit')}
          </button>
        </form>

        <GoogleButton next={from} />

      </div>
    </div>
  );
}
