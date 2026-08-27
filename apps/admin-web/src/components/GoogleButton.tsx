import { useEffect, useState } from 'react';

/**
 * "Continue with Google" for the platform console.
 *
 * Deliberately not translated: the console is NODE X's own tool, not a
 * customer-facing surface, so it stays in one language while the clinic app
 * ships Shqip and English.
 *
 * Rendered only when the server reports Google as configured — a console
 * offering a button that dead-ends on a Google error page is worse than one
 * that only offers a password.
 */
export default function GoogleButton() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/auth/providers')
      .then((r) => (r.ok ? r.json() : { google: false }))
      .then((d: { google?: boolean }) => live && setAvailable(Boolean(d.google)))
      .catch(() => {
        /* leave hidden; password login still works */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!available) return null;

  return (
    <>
      <div className="authdivider"><span>or</span></div>
      <button
        type="button"
        className="btn btn--google"
        onClick={() => {
          // A full navigation: the browser must own an OAuth redirect for
          // Google's own session and consent screens to work.
          window.location.href = '/api/platform/auth/google';
        }}
      >
        <GoogleMark />
        Continue with Google
      </button>
    </>
  );
}

/** Google's mark, inline — no remote image request. */
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
