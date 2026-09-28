import { useMinute } from '../lib/useMinute';

/**
 * "Waiting 12 min" for a patient who is checked in: the desk's cue to tell
 * the dentist, or to apologise. Amber once the wait needs a word. `since` is
 * an instant, compared with the real clock (not a calendar's wall time).
 */
export default function WaitingPill({ since }: { since: string }) {
  const now = useMinute();
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  return (
    <span className={`pill ${minutes >= 20 ? 'pill--warn' : 'pill--info'}`}>
      Waiting {minutes < 1 ? 'just now' : `${minutes} min`}
    </span>
  );
}
