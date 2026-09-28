import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { t } from '../lib/strings';

/**
 * Where Google sends the browser back.
 *
 * The API puts the session in the URL FRAGMENT, which never reaches a server,
 * so the token stays out of access logs, out of the Referer header on the next
 * navigation, and out of any proxy in between. This page reads it, clears it
 * from the address bar before React renders anything else, and hands it to the
 * auth context.
 */
export default function AuthCallbackPage() {
  const { adoptSession } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // React 18 mounts effects twice in development; the hash is consumed once.
  const consumed = useRef(false);

  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;

    const params = new URLSearchParams(window.location.hash.slice(1));
    const access = params.get('access');
    const refresh = params.get('refresh') ?? undefined;
    const next = params.get('next') || '/';
    const challenge = params.get('mfa');
    const stage = params.get('stage');

    // Clear it immediately, before any await: a token sitting in the address
    // bar ends up in screenshots, shoulder-surfing and browser history.
    window.history.replaceState(null, '', window.location.pathname);

    // Google proved the first factor; the account needs a second. Continue at
    // the sign-in page's MFA step, carrying the challenge in router state.
    if (challenge && (stage === 'verify' || stage === 'enroll')) {
      navigate('/login', {
        replace: true,
        state: { challenge: { token: challenge, stage }, next },
      });
      return;
    }

    if (!access) {
      setError(t('login.error'));
      return;
    }

    adoptSession(access, refresh)
      .then(() => navigate(next, { replace: true }))
      .catch(() => setError(t('login.error')));
  }, [adoptSession, navigate]);

  return (
    <div className="auth">
      <div className="auth__panel">
        {error ? (
          <>
            <h1 className="auth__title">{error}</h1>
            <button className="btn btn--primary" onClick={() => navigate('/login')}>
              {t('login.submit')}
            </button>
          </>
        ) : (
          <p className="auth__sub">{t('common.loading')}</p>
        )}
      </div>
    </div>
  );
}
