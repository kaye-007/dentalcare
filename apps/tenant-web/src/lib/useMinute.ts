import { useEffect, useState } from 'react';

/**
 * The current time, refreshed once a minute.
 *
 * For views that mark "now" — the next patient on the dashboard, the time line
 * on the calendar — so they move on through the day without a reload. A minute
 * is the finest grain either one shows.
 */
export function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
