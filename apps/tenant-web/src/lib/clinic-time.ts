/**
 * Clinic time.
 *
 * An appointment at 09:00 is 09:00 on the clinic's wall clock (Europe/Tirane
 * for most clinics), whatever zone the computer showing it is set to. The
 * browser's own zone is never the reference: a laptop left on another zone,
 * or an owner checking the calendar abroad, must see the same 09:00 the
 * front desk booked.
 *
 * Two representations meet here:
 *
 *   instant     what the API stores and returns: an ISO timestamp, a moment
 *   wall Date   a browser Date whose LOCAL fields (getHours, getDate…) read
 *               the clinic's wall clock. The calendar's layout arithmetic
 *               works on these, so it needs no zone awareness of its own.
 *
 * Convert at the edges — when appointments arrive, when a time is sent — and
 * never mix the two inside.
 *
 * The zone is the clinic's, set once when the signed-in user loads (see
 * AuthProvider), like the currency.
 */

let zone = 'Europe/Tirane';

export function setClinicZone(tz: string) {
  zone = tz;
}

export function clinicZone(): string {
  return zone;
}

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(at: Date): Parts {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    formatters.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

/** The instant as a wall Date: its local fields read the clinic's clock. */
export function toWall(at: Date | string | number): Date {
  const p = wallParts(new Date(at));
  return new Date(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
}

/** Now, on the clinic's clock. */
export function wallNow(): Date {
  return toWall(Date.now());
}

/**
 * The instant at which the clinic's clock reads this date and time. Found by
 * guessing it as UTC and correcting by the zone's offset at the guess —
 * twice, so a guess that lands across a daylight-saving change still settles.
 */
export function clinicInstant(
  y: number,
  m: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
): Date {
  const wanted = Date.UTC(y, m - 1, d, h, mi, s);
  let t = wanted;
  for (let i = 0; i < 2; i++) {
    const p = wallParts(new Date(t));
    t += wanted - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  }
  return new Date(t);
}

/** A wall Date back to the instant it stands for. */
export function fromWall(wall: Date): Date {
  return clinicInstant(
    wall.getFullYear(),
    wall.getMonth() + 1,
    wall.getDate(),
    wall.getHours(),
    wall.getMinutes(),
    wall.getSeconds(),
  );
}

/** "2026-09-28" and "09:00" on the clinic's clock, as the ISO instant the API stores. */
export function clinicISO(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return clinicInstant(y!, m!, d!, h!, mi!).toISOString();
}

/** Formatting options that show an instant on the clinic's clock. */
export function inClinicZone(
  opts: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatOptions {
  return { ...opts, timeZone: zone };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * An instant as a zone-less "2026-09-28T09:00:00" on the clinic's clock.
 * `new Date()` of that string is the wall Date, so code that reads a
 * timestamp string with local getters sees the clinic's time.
 */
export function toWallString(at: string): string {
  const w = toWall(at);
  return (
    `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())}` +
    `T${pad(w.getHours())}:${pad(w.getMinutes())}:${pad(w.getSeconds())}`
  );
}

/** The reverse of toWallString: back to the ISO instant. */
export function fromWallString(wall: string): string {
  return fromWall(new Date(wall)).toISOString();
}
