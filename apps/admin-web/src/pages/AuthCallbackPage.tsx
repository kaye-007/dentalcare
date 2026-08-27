import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/**
 * Where Google sends the console back.
 *
 * The API returns the session in the URL fragment, which never reaches a
 * server — so the token stays out of access logs, out of Referer, and out of
 * any proxy. Read once, cleared from the address bar before anything else
 * renders.
 */
export default function AuthCallbackPage() {
  const { adoptSession } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const consumed = useRef(false);

  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;

    const params = new URLSearchParams(window.location.hash.slice(1));
    const access = params.get('access');
    const next = params.get('next') || '/';
    window.history.replaceState(null, '', window.location.pathname);

    if (!access) {
      setError('Sign-in did not complete.');
      return;
    }
    adoptSession(access)
      .then(() => navigate(next, { replace: true }))
      .catch(() => setError('Sign-in did not complete.'));
  }, [adoptSession, navigate]);

  return (
    <div className="auth">
      <div className="auth__panel">
        {error ? (
          <>
            <h1 className="auth__title">{error}</h1>
            <button className="btn btn--primary" onClick={() => navigate('/login')}>
              Back to sign in
            </button>
          </>
        ) : (
          <p className="muted">Signing you in…</p>
        )}
      </div>
    </div>
  );
}
