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
 *
 * Every console account uses two-step sign-in, so the fragment usually
 * carries a challenge rather than a session: Google proved the first factor,
 * and the sign-in page takes it from there.
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
    const refresh = params.get('refresh') ?? undefined;
    const challenge = params.get('mfa');
    const stage = params.get('stage');
    const next = params.get('next') || '/';
    window.history.replaceState(null, '', window.location.pathname);

    if (challenge && (stage === 'verify' || stage === 'enroll')) {
      navigate('/login', {
        replace: true,
        state: { challenge: { token: challenge, stage } },
      });
      return;
    }

    if (!access) {
      setError('Sign-in did not complete.');
      return;
    }
    adoptSession(access, refresh)
      .then(() => navigate(next, { replace: true }))
      .catch(() => setError('Sign-in did not complete.'));
  }, [adoptSession, navigate]);

  return (
    <div className="auth" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <main className="auth__main">
        <div className="auth__panel auth__panel--card">
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
      </main>
    </div>
  );
}
