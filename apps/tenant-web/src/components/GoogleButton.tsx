import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n';

/**
 * "Continue with Google".
 *
 * Rendered only when the server reports Google as configured, so a deployment
 * without credentials shows a password form rather than a button that dead-ends
 * on a Google error page.
 *
 * Styled from the Phase A tokens rather than Google's brand sheet: a white
 * card with a blue wordmark would be the only element on this screen that does
 * not belong to the product. The mark itself is Google's four colours, which
 * is what makes it recognisable.
 */
export default function GoogleButton({
  plane = 'clinic',
  next,
}: {
  plane?: 'clinic' | 'platform';
  next?: string;
}) {
  const t = useT();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/auth/providers')
      .then((r) => (r.ok ? r.json() : { google: false }))
      .then((d: { google?: boolean }) => {
        if (live) setAvailable(Boolean(d.google));
      })
      .catch(() => {
        /* leave the button hidden; password login still works */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!available) return null;

  function start() {
    const params = new URLSearchParams();
    if (plane === 'clinic') params.set('clinic', clinicSubdomain());
    if (next) params.set('next', next);
    // A full navigation, not fetch: this is an OAuth redirect, and the browser
    // has to own it for Google's own session and consent screens to work.
    window.location.href =
      (plane === 'platform' ? '/api/platform/auth/google?' : '/api/auth/google?') +
      params.toString();
  }

  return (
    <>
      <div className="authdivider">
        <span>{t('login.or')}</span>
      </div>
      <button type="button" className="btn btn--google" onClick={start}>
        <GoogleMark />
        {t('login.google')}
      </button>
    </>
  );
}

/**
 * Which clinic is signing in.
 *
 * Production hosts are `avicena.dentalcare.app`, so the first label is the
 * clinic. On localhost there is no label to read, and the dev fallback names
 * the same clinic the API's DEV_TENANT_SUBDOMAIN resolves to.
 */
function clinicSubdomain(): string {
  const labels = window.location.hostname.split('.');
  if (labels.length >= 3 && labels[0] && labels[0] !== 'www') return labels[0]!;
  return import.meta.env.VITE_DEV_CLINIC ?? 'demo';
}

/** Google's mark, inline — the CSP on the artifact host blocks remote images. */
function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2.5 24 .5 14.6.5 6.5 5.8 2.6 13.5l7.8 6c1.9-5.7 7.2-10 13.6-10z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.9-10 6.9-17.3z" />
      <path fill="#FBBC05" d="M10.4 28.5a14.5 14.5 0 0 1 0-9l-7.8-6a24 24 0 0 0 0 21l7.8-6z" />
      <path fill="#34A853" d="M24 47.5c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.4 0-11.7-4.3-13.6-10l-7.8 6C6.5 42.2 14.6 47.5 24 47.5z" />
    </svg>
  );
}
