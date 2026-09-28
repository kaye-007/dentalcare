import { useEffect, useState } from 'react';

const QUERY = '(max-width: 760px)';

/**
 * True while a media query matches. Follows the window as it resizes or the
 * device rotates, for layouts that change shape rather than just style.
 */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query).matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatches(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/**
 * True at phone width — the same 760px line the stylesheets use (a form that
 * becomes one step per screen).
 */
export function useIsPhone(): boolean {
  return useMedia(QUERY);
}
