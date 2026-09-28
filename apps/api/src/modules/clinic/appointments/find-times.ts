/**
 * Finding a time: the arithmetic behind "when can she come in?"
 *
 * The front desk should not have to work availability out by eye. Given how
 * long the visit takes, this walks the clinic's days and offers the times at
 * which a practitioner is working and free, a room is free, and the patient
 * is not booked elsewhere. Those are the three conflicts the database refuses
 * (appointment_no_staff/operatory/patient_overlap), so a time offered here
 * books — unless someone takes it first, which the constraint still catches.
 *
 * Pure data and pure functions, like the status machine: the service gathers
 * the facts, this decides, and the rules can be tested without a database.
 *
 * Working hours are a practitioner's own weekly shifts when they have any,
 * and the clinic's opening hours otherwise. A closure — a public holiday, or
 * one person's leave — wins over both.
 */

/** One day of the clinic's week. `day` is 0 = Monday, as working_hours stores it. */
export interface OpeningDay {
  day: number;
  closed: boolean;
  open: string;
  close: string;
}

export interface Practitioner {
  id: string;
  name: string;
  /** The room their bookings start in (0019), when it is free. */
  homeRoomId: string | null;
  /** Weekly shifts. `weekday` is 0 = Sunday, as staff_availability stores it. */
  shifts: { weekday: number; start: string; end: string }[];
}

export interface Room {
  id: string;
  name: string;
  color: string | null;
}

/** Something already booked that holds a person, a room and a patient. */
export interface Busy {
  staffId: string | null;
  roomId: string | null;
  patientId: string;
  start: number;
  end: number;
}

/** A holiday (staffId null) or one practitioner's time off, as calendar dates. */
export interface Closure {
  staffId: string | null;
  startsOn: string;
  endsOn: string;
}

export interface FindTimesInput {
  /** The clinic's IANA zone. Every wall time below is on its clock. */
  zone: string;
  now: number;
  /** The first clinic date to look at, YYYY-MM-DD. */
  from: string;
  days: number;
  durationMinutes: number;
  opening: OpeningDay[];
  /** Who may be booked. Empty: the clinic books without naming anyone. */
  practitioners: Practitioner[];
  /** Rooms in service, in the clinic's order. Empty: the clinic has none. */
  rooms: Room[];
  closures: Closure[];
  busy: Busy[];
  patientId?: string | null;
  /** Offered first when more than one practitioner is free at a time. */
  preferStaffId?: string | null;
  /** Tried first for the room, after the practitioner's own. */
  preferRoomId?: string | null;
  /** A few times a day, spread across it; otherwise every free start. */
  spread: boolean;
  /** Stop after the day on which this many times have been found. */
  limit: number;
}

export interface FoundTime {
  startsAt: string;
  endsAt: string;
  staffId: string | null;
  staffName: string | null;
  operatoryId: string | null;
  operatoryName: string | null;
  operatoryColor: string | null;
}

export interface FindTimesResult {
  times: FoundTime[];
  /** The day after the last one looked at: where "more times" carries on. */
  nextFrom: string;
}

const MINUTE = 60_000;
/** Times are offered on the quarter hour, the way the desk says them. */
export const STEP_MINUTES = 15;
/** Nothing is offered that starts in less than this from now. */
const LEAD_MINUTES = 5;
/**
 * A spread day offers its first free time in each part of the day — morning,
 * midday, afternoon — which is how the question is usually answered on the
 * phone: "tomorrow at nine, at twelve, or at three?"
 */
const DAY_PARTS = ['00:00', '12:00', '15:00'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d!));
  return (
    at.getUTCFullYear() === y && at.getUTCMonth() === m! - 1 && at.getUTCDate() === d
  );
}

/** "2026-09-28" + n days, as a calendar date (no zone involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a calendar date. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function wallParts(zone: string, at: number) {
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
  const p = Object.fromEntries(
    f.formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]),
  );
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

/** The clinic's calendar date at an instant. */
export function clinicDate(zone: string, at: number): string {
  const p = wallParts(zone, at);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/**
 * The instant at which the clinic's clock reads `date` `time`. Guessed as UTC
 * and corrected by the zone's offset at the guess — twice, so a guess that
 * lands across a daylight-saving change still settles. The same method the
 * web client uses (lib/clinic-time), so both sides agree on every instant.
 */
export function zonedInstant(zone: string, date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wanted = Date.UTC(y!, m! - 1, d!, h!, mi!);
  let t = wanted;
  for (let i = 0; i < 2; i++) {
    const p = wallParts(zone, t);
    t += wanted - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  }
  return t;
}

const overlaps = (list: Busy[] | undefined, start: number, end: number) =>
  Boolean(list?.some((b) => b.start < end && b.end > start));

function group(busy: Busy[], key: (b: Busy) => string | null) {
  const out = new Map<string, Busy[]>();
  for (const b of busy) {
    const k = key(b);
    if (!k) continue;
    const list = out.get(k);
    if (list) list.push(b);
    else out.set(k, [b]);
  }
  return out;
}

export function findTimes(input: FindTimesInput): FindTimesResult {
  const duration = input.durationMinutes * MINUTE;
  const step = STEP_MINUTES * MINUTE;
  const earliest = input.now + LEAD_MINUTES * MINUTE;
  const byStaff = group(input.busy, (b) => b.staffId);
  const byRoom = group(input.busy, (b) => b.roomId);
  const patientBusy = input.patientId
    ? input.busy.filter((b) => b.patientId === input.patientId)
    : [];
  const roomIds = new Set(input.rooms.map((r) => r.id));

  const closedOn = (date: string, staffId: string | null) =>
    input.closures.some(
      (c) => c.staffId === staffId && c.startsOn <= date && date <= c.endsOn,
    );

  // The first free room for [start, end): the practitioner's own, then the
  // one asked for, then the clinic's rooms in order.
  const roomFor = (start: number, end: number, home: string | null) => {
    const order = [home, input.preferRoomId ?? null, ...input.rooms.map((r) => r.id)];
    for (const id of order) {
      if (id && roomIds.has(id) && !overlaps(byRoom.get(id), start, end)) {
        return input.rooms.find((r) => r.id === id)!;
      }
    }
    return null;
  };

  const times: FoundTime[] = [];
  let date = input.from;
  for (let i = 0; i < input.days; i++, date = addDays(input.from, i)) {
    if (times.length >= input.limit) break;
    if (closedOn(date, null)) continue;

    const sunday0 = weekdayOf(date);
    const today = input.opening.find((o) => o.day === (sunday0 + 6) % 7);
    const clinicWindow =
      today && !today.closed && TIME.test(today.open) && TIME.test(today.close)
        ? [{ start: today.open, end: today.close }]
        : [];
    const bookingsToday = (id: string) => {
      const from = zonedInstant(input.zone, date, '00:00');
      const to = zonedInstant(input.zone, addDays(date, 1), '00:00');
      return (byStaff.get(id) ?? []).filter((b) => b.start < to && b.end > from).length;
    };

    // The preferred practitioner first, then whoever has the lightest day,
    // so the offer spreads work rather than filling one diary.
    const people: (Practitioner | null)[] = input.practitioners.length
      ? [...input.practitioners].sort(
          (a, b) =>
            Number(b.id === input.preferStaffId) - Number(a.id === input.preferStaffId) ||
            bookingsToday(a.id) - bookingsToday(b.id) ||
            a.name.localeCompare(b.name),
        )
      : [null];

    // Each start time goes to the first person in that order who is free.
    const found = new Map<number, FoundTime>();
    for (const person of people) {
      if (person && closedOn(date, person.id)) continue;
      const windows =
        person && person.shifts.length > 0
          ? person.shifts.filter((s) => s.weekday === sunday0)
          : clinicWindow;
      for (const w of windows) {
        if (!TIME.test(w.start) || !TIME.test(w.end)) continue;
        const open = zonedInstant(input.zone, date, w.start);
        const close = zonedInstant(input.zone, date, w.end);
        for (let t = Math.ceil(open / step) * step; t + duration <= close; t += step) {
          if (t < earliest || found.has(t)) continue;
          const end = t + duration;
          if (overlaps(patientBusy, t, end)) continue;
          if (person && overlaps(byStaff.get(person.id), t, end)) continue;
          const room = input.rooms.length
            ? roomFor(t, end, person?.homeRoomId ?? null)
            : null;
          if (input.rooms.length && !room) continue;
          found.set(t, {
            startsAt: new Date(t).toISOString(),
            endsAt: new Date(end).toISOString(),
            staffId: person?.id ?? null,
            staffName: person?.name ?? null,
            operatoryId: room?.id ?? null,
            operatoryName: room?.name ?? null,
            operatoryColor: room?.color ?? null,
          });
        }
      }
    }

    const starts = [...found.keys()].sort((a, b) => a - b);
    if (!input.spread) {
      for (const t of starts) times.push(found.get(t)!);
      continue;
    }
    const parts = DAY_PARTS.map((p) => zonedInstant(input.zone, date, p));
    parts.forEach((partStart, k) => {
      const partEnd = parts[k + 1] ?? Infinity;
      const first = starts.find((t) => t >= partStart && t < partEnd);
      if (first !== undefined) times.push(found.get(first)!);
    });
  }

  return { times, nextFrom: date };
}
