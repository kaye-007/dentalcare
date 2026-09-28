import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, BellRing, Check, Clock, History, Search } from 'lucide-react';
import {
  ApiError,
  api,
  appointmentsApi,
  closuresApi,
  humanError,
  operatoriesApi,
  settingsApi,
  treatmentsApi,
  type Appointment,
  type ApptStatus,
  type Closure,
  type FoundTime,
  type Operatory,
  type Patient,
  type StaffMember,
  type StatusEvent,
  type Treatment,
  type WorkingDay,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Avatar,
  Disclosure,
  LoadingRows,
  MoreMenu,
  Segmented,
  SidePanel,
  StatusPill,
  useToast,
  type MoreItem,
} from './ui';
import PatientPicker from './PatientPicker';
import { dateLocale, t } from '../lib/strings';
import { clinicISO, inClinicZone, toWall, wallNow } from '../lib/clinic-time';
import { formatMoney } from '../lib/format';
import { loadPractitioners } from '../lib/practitioners';
import { useMessaging } from '../lib/messaging';

const DURATIONS = [15, 20, 30, 45, 60, 90, 120];

/** Statuses that hold a room — the same set the database's room rule uses. */
const HOLDS_ROOM: ApptStatus[] = ['scheduled', 'checked_in', 'in_progress'];

const pad = (n: number) => String(n).padStart(2, '0');
/** A wall Date's calendar date, "2026-09-28" (lib/clinic-time). */
const ymd = (w: Date) =>
  `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())}`;
/** A wall Date's clock time, "09:30". */
const hm = (w: Date) => `${pad(w.getHours())}:${pad(w.getMinutes())}`;
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isHm = (s: string) => /^\d{2}:\d{2}$/.test(s);

/** "2026-09-28" → "2026-09-29" */
function nextDate(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

/** "Today", "Tomorrow", or "Friday 2 October" for a date on the clinic's calendar. */
function dayName(date: string) {
  const today = ymd(wallNow());
  if (date === today) return 'Today';
  if (date === nextDate(today)) return 'Tomorrow';
  return new Date(`${date}T12:00:00`).toLocaleDateString(dateLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

/* Instants from the API, shown on the clinic's clock (lib/clinic-time). */
function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString(
    dateLocale(),
    inClinicZone({ hour: '2-digit', minute: '2-digit' }),
  );
}
function fmtDateTime(s: string) {
  return new Date(s).toLocaleString(
    dateLocale(),
    inClinicZone({
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }),
  );
}
function fmtStamp(s: string) {
  return new Date(s).toLocaleString(
    dateLocale(),
    inClinicZone({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  );
}
/** "Tomorrow, 10:30" for an instant. */
function fmtWhen(s: string) {
  const w = toWall(s);
  return `${dayName(ymd(w))}, ${hm(w)}`;
}
const minutesBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 60_000);

/** Letters without their accents, lowercase: "Pastrim" matches "pastrim". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function closedOn(hours: WorkingDay[] | null, date: string) {
  if (!hours || !isYmd(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const weekday = (new Date(y!, m! - 1, d!).getDay() + 6) % 7; // Monday = 0
  return hours.find((w) => w.day === weekday)?.closed ?? false;
}

/* ══════════════════════════════════════════════════════════════
   What both panels need
   ══════════════════════════════════════════════════════════════ */

/** Rooms, services, opening hours, the usual visit length, and who can be booked. */
function useClinicData(given?: StaffMember[], withServices = true) {
  const [rooms, setRooms] = useState<Operatory[]>([]);
  const [treatments, setTreatments] = useState<Treatment[] | null>(null);
  const [hours, setHours] = useState<WorkingDay[] | null>(null);
  const [visitLength, setVisitLength] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<StaffMember[] | null>(null);

  useEffect(() => {
    operatoriesApi
      .list()
      .then(setRooms)
      .catch(() => setRooms([]));
    // The catalogue fills in what the visit is for and how long it takes.
    // If it cannot load, the reason is typed instead.
    if (withServices) {
      treatmentsApi
        .list({ status: 'active' })
        .then(setTreatments)
        .catch(() => setTreatments([]));
    }
    // Opening hours and the clinic's usual visit length (Settings › Opening
    // hours). Without them a plain day and 45 minutes are assumed.
    settingsApi
      .get()
      .then((s) => {
        setHours(s.workingHours);
        setVisitLength(s.defaultAppointmentDuration || 45);
      })
      .catch(() => setVisitLength(45));
  }, [withServices]);

  useEffect(() => {
    if (given) return;
    loadPractitioners()
      .then(setLoaded)
      .catch(() => setLoaded([]));
  }, [given]);

  return { rooms, treatments, hours, visitLength, staff: given ?? loaded ?? [] };
}

/**
 * What else holds a time typed by hand: the practitioner, the room, the
 * patient. The database refuses all three, so they are said before anyone
 * presses Book — with the way out, never "book anyway". A closure is the one
 * exception the clinic may knowingly book through.
 */
function useTimeCheck(p: {
  date: string;
  time: string;
  duration: number;
  staffId: string;
  operatoryId: string;
  patientId: string;
  ignoreId?: string;
}) {
  const [dayAppts, setDayAppts] = useState<Appointment[]>([]);
  const [closures, setClosures] = useState<Closure[]>([]);
  const { date } = p;
  useEffect(() => {
    if (!isYmd(date)) {
      setDayAppts([]);
      setClosures([]);
      return;
    }
    let off = false;
    appointmentsApi
      .list({ from: clinicISO(date, '00:00'), to: clinicISO(nextDate(date), '00:00') })
      .then((l) => !off && setDayAppts(l))
      .catch(() => !off && setDayAppts([]));
    closuresApi
      .list(date, date)
      .then((c) => !off && setClosures(c))
      .catch(() => !off && setClosures([]));
    return () => {
      off = true;
    };
  }, [date]);

  return useMemo(() => {
    const roomTakenBy = new Map<string, Appointment>();
    let staff: Appointment | undefined;
    let patient: Appointment | undefined;
    if (isYmd(p.date) && isHm(p.time)) {
      const from = Date.parse(clinicISO(p.date, p.time));
      const to = from + p.duration * 60_000;
      for (const a of dayAppts) {
        if (a.id === p.ignoreId || !HOLDS_ROOM.includes(a.status)) continue;
        if (!(Date.parse(a.startsAt) < to && Date.parse(a.endsAt) > from)) continue;
        if (a.operatoryId && !roomTakenBy.has(a.operatoryId))
          roomTakenBy.set(a.operatoryId, a);
        if (p.staffId && a.staffId === p.staffId) staff ??= a;
        if (p.patientId && a.patientId === p.patientId) patient ??= a;
      }
    }
    const room = p.operatoryId ? roomTakenBy.get(p.operatoryId) : undefined;
    const closure =
      closures.find((c) => c.staffId === null || c.staffId === p.staffId) ?? null;
    return { roomTakenBy, staff, room, patient, closure };
  }, [
    dayAppts,
    closures,
    p.date,
    p.time,
    p.duration,
    p.staffId,
    p.operatoryId,
    p.patientId,
    p.ignoreId,
  ]);
}
type TimeCheck = ReturnType<typeof useTimeCheck>;

/* ══════════════════════════════════════════════════════════════
   Finding a time
   ══════════════════════════════════════════════════════════════ */

/**
 * The times a visit can be booked, as the desk wants them: the soonest few,
 * a day at a time, each with the dentist and room already worked out by the
 * server (working hours, closures, everyone's bookings, the patient's own).
 * One tap picks a time. "Choose a day" lists every free start on one day.
 */
export function TimeFinder({
  duration,
  patientId,
  ignore,
  staff,
  whoId,
  onWho,
  usualId,
  preferOperatoryId,
  initialDay,
  chosenStart,
  onChoose,
  alert,
  reloadKey = 0,
  busy = false,
  current,
}: {
  duration: number;
  patientId?: string;
  /** The visit being moved, left out of the conflicts. */
  ignore?: string;
  /** Where that visit is now — not offered as somewhere to move it to. */
  current?: { startsAt: string; staffId: string | null };
  staff: StaffMember[];
  /** '' is "first available". */
  whoId: string;
  onWho: (id: string) => void;
  /** The patient's own dentist, marked in the chips. */
  usualId?: string | null;
  preferOperatoryId?: string;
  /** Open on this day instead of the soonest times. */
  initialDay?: string;
  chosenStart: string | null;
  onChoose: (t: FoundTime) => void;
  /** What went wrong with the last choice — shown above the fresh times. */
  alert?: string | null;
  /** Bump to look again (after a time was taken). */
  reloadKey?: number;
  busy?: boolean;
}) {
  const today = ymd(wallNow());
  // A later day the calendar was showing opens on that day; otherwise the soonest.
  const later = initialDay !== undefined && initialDay > today;
  const [mode, setMode] = useState<'soon' | 'day'>(later ? 'day' : 'soon');
  const [day, setDay] = useState(later ? initialDay : today);
  const [times, setTimes] = useState<FoundTime[] | null>(null);
  const [nextFrom, setNextFrom] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [emptyMore, setEmptyMore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      duration,
      staffId: whoId || undefined,
      patientId: patientId || undefined,
      ignore,
      preferOperatoryId: preferOperatoryId || undefined,
    }),
    [duration, whoId, patientId, ignore, preferOperatoryId],
  );
  // A visit being moved is free at its own time, by definition; that is not a move.
  const currentStart = current ? Date.parse(current.startsAt) : null;
  const currentStaff = current?.staffId ?? null;
  const isCurrent = useCallback(
    (x: FoundTime) =>
      currentStart !== null &&
      Date.parse(x.startsAt) === currentStart &&
      x.staffId === currentStaff,
    [currentStart, currentStaff],
  );

  useEffect(() => {
    let off = false;
    setTimes(null);
    setError(null);
    setEmptyMore(null);
    (mode === 'soon'
      ? appointmentsApi.findTimes(query)
      : appointmentsApi.findTimes({ ...query, from: day, days: 1, spread: false })
    )
      .then((r) => {
        if (off) return;
        setTimes(r.times.filter((x) => !isCurrent(x)));
        setNextFrom(r.nextFrom);
      })
      .catch((err) => {
        if (off) return;
        setTimes([]);
        setError(humanError(err, 'Free times could not be loaded. Try again.'));
      });
    return () => {
      off = true;
    };
  }, [query, mode, day, reloadKey, isCurrent]);

  async function loadMore() {
    if (!nextFrom) return;
    setMore(true);
    setEmptyMore(null);
    try {
      const r = await appointmentsApi.findTimes({ ...query, from: nextFrom });
      setTimes((cur) => [...(cur ?? []), ...r.times.filter((x) => !isCurrent(x))]);
      if (r.times.length === 0) {
        setEmptyMore(
          `Nothing free before ${new Date(`${r.nextFrom}T12:00:00`).toLocaleDateString(
            dateLocale(),
            { day: 'numeric', month: 'long' },
          )}.`,
        );
      }
      setNextFrom(r.nextFrom);
    } catch (err) {
      setError(humanError(err, 'More times could not be loaded. Try again.'));
    } finally {
      setMore(false);
    }
  }

  const groups = useMemo(() => {
    const byDay = new Map<string, FoundTime[]>();
    for (const x of times ?? []) {
      const d = ymd(toWall(x.startsAt));
      const list = byDay.get(d);
      if (list) list.push(x);
      else byDay.set(d, [x]);
    }
    return [...byDay.entries()];
  }, [times]);

  const whoName = staff.find((s) => s.id === whoId)?.fullName;
  const place = (x: FoundTime) =>
    [x.staffName, x.operatoryName].filter(Boolean).join(' · ');
  const chosen = times?.find((x) => x.startsAt === chosenStart);
  // The patient's own dentist comes first, right after "First available".
  const people = useMemo(
    () =>
      usualId
        ? [...staff].sort((x, y) => Number(y.id === usualId) - Number(x.id === usualId))
        : staff,
    [staff, usualId],
  );
  // The chosen chip is kept in view on a narrow row, never left past its edge.
  const whoRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = whoRef.current;
    const on = row?.querySelector<HTMLElement>('.chip--on');
    if (!row || !on || row.scrollWidth <= row.clientWidth) return;
    const box = row.getBoundingClientRect();
    const chip = on.getBoundingClientRect();
    // Only as far as it takes: the row stays where it is if the chip shows.
    if (chip.right > box.right) row.scrollLeft += chip.right - box.right + 8;
    else if (chip.left < box.left) row.scrollLeft -= box.left - chip.left + 8;
  }, [whoId, people]);

  return (
    <div className="finder" aria-busy={times === null}>
      {staff.length > 1 && (
        <div className="finder__who" role="group" aria-label="With whom" ref={whoRef}>
          <button
            type="button"
            className={`chip${!whoId ? ' chip--on' : ''}`}
            aria-pressed={!whoId}
            onClick={() => onWho('')}
          >
            First available
          </button>
          {people.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`chip${whoId === s.id ? ' chip--on' : ''}`}
              aria-pressed={whoId === s.id}
              onClick={() => onWho(s.id)}
            >
              {s.fullName}
              {s.id === usualId && <span className="chip__tag">usual</span>}
            </button>
          ))}
        </div>
      )}

      <div className="finder__bar">
        <Segmented
          label="Which times"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'soon', label: 'Soonest' },
            { value: 'day', label: 'Choose a day' },
          ]}
        />
        {mode === 'day' && (
          <input
            type="date"
            className="finder__date"
            aria-label="Day"
            value={day}
            min={today}
            onChange={(e) => isYmd(e.target.value) && setDay(e.target.value)}
          />
        )}
      </div>

      {alert && (
        <p className="formwarn finder__alert" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>{alert}</span>
        </p>
      )}
      {error && (
        <p className="formerror" role="alert">
          {error}
        </p>
      )}

      {times === null ? (
        <LoadingRows rows={3} label="Finding free times" />
      ) : times.length === 0 ? (
        !error && (
          <div className="finder__none">
            <p>
              {mode === 'day'
                ? `Nothing free ${dayName(day) === 'Today' ? 'today' : `on ${dayName(day)}`}${
                    whoName ? ` with ${whoName}` : ''
                  }.`
                : `${whoName ?? 'Nobody'} has no free time in the next two weeks.`}
            </p>
            {whoId && (
              <button type="button" className="linkbtn" onClick={() => onWho('')}>
                Show anyone who is free
              </button>
            )}
          </div>
        )
      ) : mode === 'soon' ? (
        groups.map(([d, list]) => (
          <div className="finder__day" key={d}>
            <p className="finder__dayname">{dayName(d)}</p>
            <ul className="finder__list">
              {list.map((x) => {
                const on = x.startsAt === chosenStart;
                return (
                  <li key={x.startsAt}>
                    <button
                      type="button"
                      className={`slot${on ? ' slot--on' : ''}`}
                      aria-pressed={on}
                      disabled={busy}
                      aria-label={`${dayName(d)}, ${fmtTime(x.startsAt)}${
                        place(x) ? `, ${place(x)}` : ''
                      }`}
                      onClick={() => onChoose(x)}
                    >
                      <span className="slot__time">{fmtTime(x.startsAt)}</span>
                      <span className="slot__who">{place(x)}</span>
                      {on && <Check size={16} className="slot__tick" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      ) : (
        <>
          <div
            className="timechips"
            role="group"
            aria-label={`Free times, ${dayName(day)}`}
          >
            {times.map((x) => {
              const on = x.startsAt === chosenStart;
              return (
                <button
                  key={x.startsAt}
                  type="button"
                  className={`chip${on ? ' chip--on' : ''}`}
                  aria-pressed={on}
                  disabled={busy}
                  aria-label={`${fmtTime(x.startsAt)}${place(x) ? `, ${place(x)}` : ''}`}
                  onClick={() => onChoose(x)}
                >
                  {fmtTime(x.startsAt)}
                </button>
              );
            })}
          </div>
          {chosen && place(chosen) && <p className="formhint">With {place(chosen)}.</p>}
        </>
      )}

      {mode === 'soon' && times !== null && nextFrom && !error && (
        <div className="finder__more">
          {emptyMore && <span className="formhint">{emptyMore}</span>}
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => void loadMore()}
            disabled={more}
          >
            {more ? 'Looking…' : 'More times'}
          </button>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   The advanced layer: every field, by hand
   ══════════════════════════════════════════════════════════════ */

function WhenFields({
  staff,
  staffId,
  onStaff,
  previousStaff,
  date,
  onDate,
  time,
  onTime,
  duration,
  onDuration,
  rooms,
  operatoryId,
  onRoom,
  check,
}: {
  staff: StaffMember[];
  staffId: string;
  onStaff: (id: string) => void;
  /** A booking made with someone who no longer sees patients keeps them. */
  previousStaff?: { id: string; name: string } | null;
  date: string;
  onDate: (d: string) => void;
  time: string;
  onTime: (t: string) => void;
  duration: number;
  onDuration: (m: number) => void;
  rooms: Operatory[];
  operatoryId: string;
  onRoom: (id: string) => void;
  check: TimeCheck;
}) {
  const durationOptions = [...new Set([...DURATIONS, duration])].sort((a, b) => a - b);
  const endsAt =
    isYmd(date) && isHm(time)
      ? hm(new Date(new Date(`${date}T${time}:00`).getTime() + duration * 60_000))
      : null;
  return (
    <div className="whenfields">
      <label className="field">
        <span>Practitioner</span>
        <select value={staffId} onChange={(e) => onStaff(e.target.value)}>
          <option value="">Unassigned</option>
          {previousStaff && !staff.some((s) => s.id === previousStaff.id) && (
            <option value={previousStaff.id}>{previousStaff.name}</option>
          )}
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.fullName}
              {s.position ? ` · ${s.position}` : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="grid2">
        <label className="field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => onDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Start time</span>
          <input type="time" value={time} onChange={(e) => onTime(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>
          <Clock size={13} aria-hidden /> Length
        </span>
        <select value={duration} onChange={(e) => onDuration(Number(e.target.value))}>
          {durationOptions.map((d) => (
            <option key={d} value={d}>
              {d} min{endsAt && d === duration ? ` · until ${endsAt}` : ''}
            </option>
          ))}
        </select>
      </label>
      {rooms.length > 0 && (
        <div className="field">
          <span>Room</span>
          <div className="roompick" role="radiogroup" aria-label="Room">
            <button
              type="button"
              role="radio"
              aria-checked={!operatoryId}
              className={`chip${!operatoryId ? ' chip--on' : ''}`}
              onClick={() => onRoom('')}
            >
              No room
            </button>
            {rooms.map((r) => {
              const taken = check.roomTakenBy.get(r.id);
              const on = operatoryId === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`chip${on ? ' chip--on' : ''}${taken ? ' chip--busy' : ''}`}
                  onClick={() => onRoom(r.id)}
                  title={
                    taken
                      ? `${taken.patientName}, ${fmtTime(taken.startsAt)}–${fmtTime(taken.endsAt)}`
                      : 'Free at this time'
                  }
                >
                  <span
                    className="roompick__dot"
                    style={r.color ? { background: r.color } : undefined}
                    aria-hidden
                  />
                  {r.name}
                  {taken && (
                    <span className="roompick__busy">
                      busy till {fmtTime(taken.endsAt)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** The conflicts of a time typed by hand, each with what to do about it. */
function TimeWarnings({
  check,
  closedDay,
  date,
  staffName,
  patientName,
  rooms,
  onFindTime,
  onRoom,
}: {
  check: TimeCheck;
  closedDay: boolean;
  date: string;
  staffName: string | null;
  patientName: string;
  rooms: Operatory[];
  onFindTime: () => void;
  onRoom: (id: string) => void;
}) {
  const lines: { key: string; body: ReactNode }[] = [];
  const findTime = (
    <button type="button" className="linkbtn" onClick={onFindTime}>
      Find a free time
    </button>
  );
  if (check.staff) {
    lines.push({
      key: 'staff',
      body: (
        <>
          {staffName ?? 'This practitioner'} is with {check.staff.patientName}{' '}
          {fmtTime(check.staff.startsAt)}–{fmtTime(check.staff.endsAt)}. {findTime}
        </>
      ),
    });
  }
  if (check.patient) {
    lines.push({
      key: 'patient',
      body: (
        <>
          {patientName || 'The patient'} already has an appointment{' '}
          {fmtTime(check.patient.startsAt)}–{fmtTime(check.patient.endsAt)}. {findTime}
        </>
      ),
    });
  }
  if (check.room) {
    const free = rooms.find((r) => !check.roomTakenBy.has(r.id));
    lines.push({
      key: 'room',
      body: (
        <>
          {check.room.patientName} is in this room {fmtTime(check.room.startsAt)}–
          {fmtTime(check.room.endsAt)}.{' '}
          {free ? (
            <button type="button" className="linkbtn" onClick={() => onRoom(free.id)}>
              Use {free.name}
            </button>
          ) : (
            findTime
          )}
        </>
      ),
    });
  }
  if (check.closure) {
    lines.push({
      key: 'closure',
      body: (
        <>
          {check.closure.staffId
            ? `${check.closure.staffName ?? 'This practitioner'} is away`
            : 'The clinic is closed'}{' '}
          that day: {check.closure.reason}. It can still be booked if that is intended.
        </>
      ),
    });
  } else if (closedDay) {
    lines.push({
      key: 'closed',
      body: (
        <>
          The clinic is normally closed on{' '}
          {new Date(`${date}T12:00:00`).toLocaleDateString(dateLocale(), {
            weekday: 'long',
          })}
          s. It can still be booked if that is intended.
        </>
      ),
    });
  }
  return (
    <>
      {lines.map((l) => (
        <p className="formwarn" role="status" key={l.key}>
          <AlertTriangle size={14} aria-hidden />
          <span>{l.body}</span>
        </p>
      ))}
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   Booking: patient → service → time → book
   ══════════════════════════════════════════════════════════════ */

type StepKey = 'patient' | 'service' | 'time';

/** One step of the booking. Done, it folds to one line that says what was chosen. */
function Step({
  n,
  id,
  title,
  done,
  open,
  value,
  onChange,
  children,
}: {
  n: number;
  id: StepKey;
  title: string;
  done: boolean;
  open: boolean;
  value?: ReactNode;
  onChange?: () => void;
  children?: ReactNode;
}) {
  return (
    <li
      className={`step${done ? ' step--done' : ''}${open ? ' step--open' : ' step--folded'}`}
      data-step={id}
    >
      <span className="step__num" aria-hidden>
        {done ? <Check size={16} /> : n}
      </span>
      <div className="step__body">
        <div className="step__line">
          <h3 className="step__title" tabIndex={-1}>
            {title}
            {done && <span className="sr-only"> (chosen)</span>}
          </h3>
          {!open && done && onChange && (
            <button
              type="button"
              className="linkbtn step__change"
              onClick={onChange}
              aria-label={`Change ${title.toLowerCase()}`}
            >
              Change
            </button>
          )}
        </div>
        {!open && done && value && <div className="step__value">{value}</div>}
        {open && children}
      </div>
    </li>
  );
}

function ServiceList({
  treatments,
  chosenId,
  onPick,
  onOther,
}: {
  treatments: Treatment[];
  chosenId: string;
  onPick: (tr: Treatment) => void;
  onOther: () => void;
}) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const term = fold(q.trim());
    return term ? treatments.filter((tr) => fold(tr.name).includes(term)) : treatments;
  }, [treatments, q]);
  return (
    <div className="svclist">
      {treatments.length > 8 && (
        <label className="svcpick__search">
          <Search size={15} aria-hidden />
          <span className="sr-only">Search services</span>
          <input
            type="search"
            value={q}
            placeholder="Search services…"
            autoComplete="off"
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
      )}
      <ul className="svclist__list">
        {list.map((tr) => (
          <li key={tr.id}>
            <button
              type="button"
              className={`svcrow${tr.id === chosenId ? ' svcrow--on' : ''}`}
              aria-pressed={tr.id === chosenId}
              onClick={() => onPick(tr)}
            >
              <span className="svcrow__name">{tr.name}</span>
              <span className="svcrow__meta">
                {tr.durationMinutes} min · {formatMoney(tr.price)}
              </span>
            </button>
          </li>
        ))}
        {list.length === 0 && (
          <li className="svclist__none">No service matches “{q.trim()}”.</li>
        )}
      </ul>
      <button type="button" className="linkbtn svclist__other" onClick={onOther}>
        Something else…
      </button>
    </div>
  );
}

function BookPanel({
  initialStart,
  initialOperatoryId,
  initialPatientId,
  initialStaffId,
  initialTreatmentId,
  suggestedStart = false,
  staff: givenStaff,
  offerView = false,
  onClose,
  onSaved,
}: {
  initialStart?: Date;
  initialOperatoryId?: string;
  initialPatientId?: string;
  initialStaffId?: string;
  initialTreatmentId?: string;
  suggestedStart?: boolean;
  staff?: StaffMember[];
  offerView?: boolean;
  onClose: () => void;
  onSaved: (at?: Date) => void;
}) {
  const { can, readOnly } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { rooms, treatments, hours, visitLength, staff } = useClinicData(givenStaff);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<StepKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* ── who ───────────────────────────────────────────── */
  const [patientId, setPatientId] = useState(initialPatientId ?? '');
  const [patientName, setPatientName] = useState('');
  const [patientInfo, setPatientInfo] = useState<Patient | null>(null);
  useEffect(() => {
    if (!patientId) {
      setPatientInfo(null);
      return;
    }
    let off = false;
    api
      .getPatient(patientId)
      .then((p) => {
        if (off) return;
        setPatientInfo(p);
        setPatientName((cur) => cur || `${p.firstName} ${p.lastName}`);
      })
      .catch(() => !off && setPatientInfo(null));
    return () => {
      off = true;
    };
  }, [patientId]);

  // The dentist who saw them last is who the times are offered with first.
  const [usualId, setUsualId] = useState<string | null>(null);
  useEffect(() => {
    setUsualId(null);
    if (!patientId) return;
    let off = false;
    appointmentsApi
      .list({ patientId, status: ['completed'] })
      .then((l) => {
        if (off) return;
        const last = [...l].reverse().find((a) => a.staffId);
        setUsualId(last?.staffId ?? null);
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [patientId]);

  /* ── what for ──────────────────────────────────────── */
  const [treatmentId, setTreatmentId] = useState('');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState<number | null>(null);
  const [serviceSet, setServiceSet] = useState(false);
  const [other, setOther] = useState(false);
  const length = duration ?? visitLength ?? 45;

  // Opened from a service (search): what it is for is already known.
  const fromService = useRef(initialTreatmentId);
  useEffect(() => {
    if (!treatments || !fromService.current) return;
    const tr = treatments.find((x) => x.id === fromService.current);
    fromService.current = undefined;
    if (!tr) return;
    setTreatmentId(tr.id);
    setReason(tr.name);
    setDuration(tr.durationMinutes);
    setServiceSet(true);
  }, [treatments]);

  function pickService(tr: Treatment) {
    setTreatmentId(tr.id);
    setReason(tr.name);
    setDuration(tr.durationMinutes);
    setOther(false);
    setServiceSet(true);
    setEditing(null);
  }

  /* ── when, with whom, where ────────────────────────── */
  // A slot someone clicked on the calendar is already the time; the New
  // button's start is only a hint of which day they were looking at.
  const known = Boolean(initialStart) && !suggestedStart;
  const [date, setDate] = useState(known ? ymd(initialStart!) : '');
  const [time, setTime] = useState(known ? hm(initialStart!) : '');
  const [staffId, setStaffId] = useState(initialStaffId ?? '');
  const [operatoryId, setOperatoryId] = useState(initialOperatoryId ?? '');
  const roomByHand = useRef(Boolean(initialOperatoryId));
  const [whoId, setWhoId] = useState(initialStaffId ?? '');
  const whoTouched = useRef(Boolean(initialStaffId));
  const [chosenStart, setChosenStart] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Times are offered with the patient's own dentist first — one tap away
  // from "First available".
  useEffect(() => {
    if (whoTouched.current || !usualId || !staff.some((s) => s.id === usualId)) return;
    setWhoId(usualId);
  }, [usualId, staff]);

  const homeOf = (id: string) => {
    const home = staff.find((s) => s.id === id)?.homeOperatoryId ?? '';
    return home && rooms.some((r) => r.id === home) ? home : '';
  };
  // A clicked slot in a dentist's column starts in their own room.
  useEffect(() => {
    if (roomByHand.current || operatoryId || !staffId || chosenStart) return;
    const home = homeOf(staffId);
    if (home) setOperatoryId(home);
    // homeOf reads staff and rooms, which are the dependencies below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, rooms, staffId]);

  function changeStaff(id: string) {
    setStaffId(id);
    setChosenStart(null);
    // A room that came with the practitioner follows them; one picked by hand stays.
    if (!roomByHand.current) setOperatoryId(homeOf(id));
  }
  function chooseTime(x: FoundTime) {
    const w = toWall(x.startsAt);
    setDate(ymd(w));
    setTime(hm(w));
    setStaffId(x.staffId ?? '');
    setOperatoryId(x.operatoryId ?? '');
    roomByHand.current = false;
    setChosenStart(x.startsAt);
    setAlert(null);
    setError(null);
    setEditing(null);
  }
  function findTime() {
    setDate('');
    setTime('');
    setChosenStart(null);
    setEditing('time');
  }

  const check = useTimeCheck({
    date,
    time,
    duration: length,
    staffId,
    operatoryId,
    patientId,
  });

  /* ── flow ──────────────────────────────────────────── */
  const patientDone = Boolean(patientId);
  const serviceDone = serviceSet && Boolean(reason.trim());
  const timeDone = isYmd(date) && isHm(time);
  const firstOpen: StepKey | null = !patientDone
    ? 'patient'
    : !serviceDone
      ? 'service'
      : !timeDone
        ? 'time'
        : null;
  const open = editing ?? firstOpen;

  // Focus follows the flow: into the patient search, onto the heading of the
  // step that is now open, and — once everything is chosen — onto Book, so
  // the keyboard and a screen reader move on with the eye.
  const firstRender = useRef(true);
  useEffect(() => {
    const root = bodyRef.current;
    const first = firstRender.current;
    firstRender.current = false;
    if (!root) return;
    if (!open) {
      if (!first) bookRef.current?.focus();
      return;
    }
    const step = root.querySelector<HTMLElement>(`[data-step="${open}"]`);
    const target =
      open === 'patient'
        ? step?.querySelector<HTMLElement>('input')
        : first
          ? null
          : step?.querySelector<HTMLElement>('.step__title');
    target?.focus();
  }, [open]);

  async function book() {
    if (!patientDone) {
      setEditing('patient');
      setError('Choose the patient first.');
      return;
    }
    if (!serviceDone) {
      setEditing('service');
      setError('Say what the visit is for.');
      return;
    }
    if (!timeDone) {
      setEditing('time');
      setError('Choose a time.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // Sent as instants, read on the clinic's clock: a bare "09:00" would be
      // stored as 09:00 UTC and show two hours late in Tirana.
      const startsAt = clinicISO(date, time);
      const endsAt = new Date(Date.parse(startsAt) + length * 60_000).toISOString();
      await appointmentsApi.create({
        patientId,
        staffId: staffId || undefined,
        operatoryId: operatoryId || undefined,
        startsAt,
        endsAt,
        reason: reason.trim(),
      });
      const [y, m, d] = date.split('-').map(Number);
      const at = new Date(
        y!,
        m! - 1,
        d!,
        Number(time.slice(0, 2)),
        Number(time.slice(3, 5)),
      );
      toast(
        `Booked ${patientName} — ${dayName(date)}, ${time}.`,
        offerView
          ? {
              action: {
                label: 'View',
                run: () => navigate(`/reservations?date=${date}`),
              },
            }
          : undefined,
      );
      onSaved(at);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 409) {
        // The error carries the way out: the time is cleared and the next
        // free times are fetched afresh, right where the choice is made.
        const knewIt = Boolean(check.staff || check.room || check.patient);
        setAlert(
          err.code === 'patient_busy'
            ? `${patientName} already has an appointment then. Here are other free times.`
            : knewIt
              ? `${err.message} Here are the free times.`
              : 'That time was just taken. Here are the next free times.',
        );
        setDate('');
        setTime('');
        setChosenStart(null);
        setEditing('time');
        setReloadKey((k) => k + 1);
        return;
      }
      setError(humanError(err, 'The appointment could not be booked. Try again.'));
    }
  }

  const canBook = can('appointments:write') && !readOnly;
  const allergies = patientInfo?.allergySummary;
  const staffName = staff.find((s) => s.id === staffId)?.fullName ?? null;
  const roomName = rooms.find((r) => r.id === operatoryId)?.name ?? null;
  const endLabel = timeDone
    ? hm(new Date(new Date(`${date}T${time}:00`).getTime() + length * 60_000))
    : '';
  const initialDay = initialStart && suggestedStart ? ymd(initialStart) : undefined;

  return (
    <SidePanel
      title="Book appointment"
      subtitle="Who, what for, and when. DentalCare finds the free times."
      onClose={onClose}
    >
      <form
        className="panel__form"
        onSubmit={(e) => {
          e.preventDefault();
          void book();
        }}
      >
        <div className="panel__body" ref={bodyRef}>
          <ol className="steps booking">
            <Step
              n={1}
              id="patient"
              title="Patient"
              done={patientDone}
              open={open === 'patient'}
              onChange={() => setEditing('patient')}
              value={
                <span className="step__who">
                  <Avatar name={patientName || '?'} size={28} />
                  <span>
                    <strong>{patientName || '…'}</strong>
                    {patientInfo?.phone && (
                      <span className="step__sub">{patientInfo.phone}</span>
                    )}
                  </span>
                </span>
              }
            >
              <PatientPicker
                canCreate={can('patients:write')}
                value={patientName}
                onPick={(p) => {
                  setPatientId(p.id);
                  setPatientName(`${p.firstName} ${p.lastName}`);
                  setError(null);
                  setEditing(null);
                }}
                onClear={() => {
                  setPatientId('');
                  setPatientName('');
                }}
              />
            </Step>

            <Step
              n={2}
              id="service"
              title="What for"
              done={serviceDone}
              open={open === 'service'}
              onChange={() => setEditing('service')}
              value={
                <>
                  <strong>{reason}</strong>
                  <span className="step__sub">{length} min</span>
                </>
              }
            >
              {treatments === null ? (
                <LoadingRows rows={3} label="Loading services" />
              ) : other || treatments.length === 0 ? (
                <div className="svcother">
                  <label className="field">
                    <span>What is the visit for?</span>
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. Check-up, Root canal — session 2"
                      maxLength={200}
                      autoFocus
                    />
                  </label>
                  <label className="field">
                    <span>Length</span>
                    <select
                      value={length}
                      onChange={(e) => setDuration(Number(e.target.value))}
                    >
                      {[...new Set([...DURATIONS, length])]
                        .sort((a, b) => a - b)
                        .map((d) => (
                          <option key={d} value={d}>
                            {d} min
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="svcother__foot">
                    {treatments.length > 0 && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setOther(false)}
                      >
                        Back to services
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={!reason.trim()}
                      onClick={() => {
                        setTreatmentId('');
                        setDuration(length);
                        setServiceSet(true);
                        setEditing(null);
                      }}
                    >
                      Continue
                    </button>
                  </div>
                </div>
              ) : (
                <ServiceList
                  treatments={treatments}
                  chosenId={treatmentId}
                  onPick={pickService}
                  onOther={() => {
                    setOther(true);
                    if (treatmentId) setReason('');
                    setTreatmentId('');
                  }}
                />
              )}
            </Step>

            <Step
              n={3}
              id="time"
              title="When"
              done={timeDone}
              open={open === 'time'}
              onChange={findTime}
              value={
                <>
                  <strong>
                    {dayName(date)} · {time}–{endLabel}
                  </strong>
                  {(staffName || roomName) && (
                    <span className="step__sub">
                      {[staffName, roomName].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </>
              }
            >
              {canBook && (
                <TimeFinder
                  duration={length}
                  patientId={patientId}
                  staff={staff}
                  whoId={whoId}
                  onWho={(id) => {
                    whoTouched.current = true;
                    setWhoId(id);
                  }}
                  usualId={usualId}
                  initialDay={initialDay}
                  chosenStart={chosenStart}
                  onChoose={chooseTime}
                  alert={alert}
                  reloadKey={reloadKey}
                  busy={busy}
                />
              )}
            </Step>
          </ol>

          {allergies && allergies.count > 0 && (
            <p
              className={`pill ${allergies.hasSevere ? 'pill--danger' : 'pill--warn'} booking__flag`}
            >
              <AlertTriangle size={13} aria-hidden />{' '}
              {allergies.hasSevere ? 'Severe allergy' : 'Allergies'}:{' '}
              {allergies.substances.join(', ')}
            </p>
          )}

          {timeDone && (
            <TimeWarnings
              check={check}
              closedDay={closedOn(hours, date)}
              date={date}
              staffName={staffName}
              patientName={patientName}
              rooms={rooms}
              onFindTime={findTime}
              onRoom={(id) => {
                roomByHand.current = true;
                setOperatoryId(id);
              }}
            />
          )}

          {/* Everything else, for whoever needs it: the exact time, the
              length, a dentist or room by hand, the wording of the reason. */}
          {canBook && (
            <Disclosure summary="Details" hint="Exact time, length, dentist, room">
              <label className="field">
                <span>Reason</span>
                <input
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    if (e.target.value.trim()) setServiceSet(true);
                  }}
                  placeholder="e.g. Check-up, Root canal — session 2"
                  maxLength={200}
                />
              </label>
              <WhenFields
                staff={staff}
                staffId={staffId}
                onStaff={changeStaff}
                date={date}
                onDate={(d) => {
                  setDate(d);
                  setChosenStart(null);
                }}
                time={time}
                onTime={(v) => {
                  setTime(v);
                  setChosenStart(null);
                }}
                duration={length}
                onDuration={(v) => {
                  setDuration(v);
                  setChosenStart(null);
                }}
                rooms={rooms}
                operatoryId={operatoryId}
                onRoom={(id) => {
                  roomByHand.current = true;
                  setOperatoryId(id);
                }}
                check={check}
              />
            </Disclosure>
          )}
        </div>

        <div className="panel__foot">
          {error && (
            <p className="formerror" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          {canBook && (
            <button
              ref={bookRef}
              type="submit"
              className="btn btn--primary"
              disabled={busy}
            >
              {busy
                ? 'Booking…'
                : timeDone && patientDone
                  ? `Book for ${time}`
                  : 'Book appointment'}
            </button>
          )}
        </div>
      </form>
    </SidePanel>
  );
}

/* ══════════════════════════════════════════════════════════════
   An existing visit: its state, the next step, move, details
   ══════════════════════════════════════════════════════════════ */

/** The next step a visit usually takes, from where it is now. */
const NEXT_STEP: Partial<Record<ApptStatus, ApptStatus>> = {
  scheduled: 'checked_in',
  checked_in: 'in_progress',
  in_progress: 'completed',
  cancelled: 'scheduled',
  no_show: 'scheduled',
};

function stepLabel(from: ApptStatus, to: ApptStatus) {
  if (to === 'checked_in') return 'Check in';
  if (to === 'in_progress') return 'Start treatment';
  if (to === 'completed') return 'Complete';
  if (to === 'no_show') return 'No-show';
  if (to === 'cancelled') return 'Cancel appointment…';
  return from === 'checked_in' ? 'Undo check-in' : 'Reinstate';
}

function VisitPanel({
  appointment,
  startWith,
  staff: givenStaff,
  onClose,
  onSaved,
}: {
  appointment: Appointment;
  startWith?: 'move';
  staff?: StaffMember[];
  onClose: () => void;
  onSaved: (at?: Date) => void;
}) {
  const { can, readOnly } = useAuth();
  const toast = useToast();
  const { rooms, hours, staff } = useClinicData(givenStaff, false);
  const canWrite = can('appointments:write') && !readOnly;
  const canMessage = can('reminders:send') && !readOnly;
  const openMessage = useMessaging();
  const a = appointment;
  const name = a.patientName;
  const editable = canWrite && a.status !== 'completed';

  const [transitions, setTransitions] = useState<Record<string, ApptStatus[]>>({});
  useEffect(() => {
    appointmentsApi
      .statuses()
      .then((s) => setTransitions(s.transitions))
      .catch(() => setTransitions({}));
  }, []);
  const allowed = transitions[a.status] ?? [];

  const [moving, setMoving] = useState(startWith === 'move');
  const [whoId, setWhoId] = useState(a.staffId ?? '');
  const [alert, setAlert] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<StatusEvent[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  /* ── status ────────────────────────────────────────── */
  const said: Partial<Record<ApptStatus, string>> = {
    checked_in: `${name} is checked in.`,
    in_progress: `${name} is in the chair.`,
    completed: `${name}’s visit is complete.`,
    no_show: `${name} is marked as a no-show.`,
    cancelled: `${name}’s appointment is cancelled.`,
    scheduled:
      a.status === 'checked_in'
        ? `${name} is no longer checked in.`
        : `${name}’s appointment is back on the calendar.`,
  };

  async function move(to: ApptStatus, reasonText?: string) {
    setError(null);
    setBusy(true);
    const from = a.status;
    try {
      await appointmentsApi.transition(a.id, to, { reason: reasonText });
      // Reversible steps say what they did and offer to take it back; the
      // way back is the way the state machine allows (to Scheduled, then on).
      const undo =
        (from === 'scheduled' || from === 'checked_in') &&
        (to === 'checked_in' || to === 'no_show' || to === 'cancelled')
          ? async () => {
              try {
                await appointmentsApi.transition(a.id, 'scheduled');
                if (from === 'checked_in')
                  await appointmentsApi.transition(a.id, 'checked_in');
                toast(
                  from === 'checked_in'
                    ? `${name} is checked in again.`
                    : to === 'checked_in'
                      ? `${name} is no longer checked in.`
                      : `${name}’s appointment is back on the calendar.`,
                );
              } catch (err) {
                toast(humanError(err, 'That could not be undone.'), 'error');
              }
              onSaved();
            }
          : null;
      toast(
        said[to] ?? 'Saved.',
        undo ? { action: { label: 'Undo', run: undo } } : undefined,
      );
      onSaved();
    } catch (err) {
      setError(humanError(err, 'The status could not be changed. Try again.'));
      setBusy(false);
    }
  }

  /* ── move ──────────────────────────────────────────── */
  async function moveTo(x: FoundTime) {
    const before = {
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      staffId: a.staffId,
      operatoryId: a.operatoryId,
    };
    setError(null);
    setBusy(true);
    try {
      await appointmentsApi.update(a.id, {
        startsAt: x.startsAt,
        endsAt: x.endsAt,
        staffId: x.staffId,
        operatoryId: x.operatoryId,
      });
      toast(`Moved ${name} to ${fmtWhen(x.startsAt)}.`, {
        action: {
          label: 'Undo',
          run: async () => {
            try {
              await appointmentsApi.update(a.id, before);
              toast(`${name} is back at ${fmtWhen(before.startsAt)}.`);
            } catch (err) {
              toast(
                err instanceof ApiError && err.status === 409
                  ? `${name} could not go back to ${fmtWhen(before.startsAt)}: that time has been taken since.`
                  : humanError(err, 'The move could not be undone.'),
                'error',
              );
            }
            onSaved();
          },
        },
      });
      onSaved(toWall(x.startsAt));
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 409) {
        setAlert('That time was just taken. Here are the next free times.');
        setReloadKey((k) => k + 1);
        return;
      }
      setError(humanError(err, 'The appointment could not be moved. Try again.'));
    }
  }

  /* ── details, by hand ──────────────────────────────── */
  const start = toWall(a.startsAt);
  const [patientId, setPatientId] = useState(a.patientId);
  const [patientName, setPatientName] = useState(a.patientName);
  const [reason, setReason] = useState(a.reason);
  const [staffId, setStaffId] = useState(a.staffId ?? '');
  const [date, setDate] = useState(ymd(start));
  const [time, setTime] = useState(hm(start));
  const [duration, setDuration] = useState(minutesBetween(a.startsAt, a.endsAt));
  const [operatoryId, setOperatoryId] = useState(a.operatoryId ?? '');
  const check = useTimeCheck({
    date,
    time,
    duration,
    staffId,
    operatoryId,
    patientId,
    ignoreId: a.id,
  });
  // An archived room stays on the booking that already has it.
  const roomChoices = useMemo(() => {
    if (!a.operatoryId || rooms.some((r) => r.id === a.operatoryId)) return rooms;
    return [
      ...rooms,
      {
        id: a.operatoryId,
        name: a.operatoryName ?? 'Previous room',
        color: a.operatoryColor ?? null,
      } as Operatory,
    ];
  }, [rooms, a]);

  async function saveDetails() {
    if (!patientId) {
      setError('Choose a patient.');
      return;
    }
    if (!reason.trim()) {
      setError('Say what the visit is for.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const startsAt = clinicISO(date, time);
      const endsAt = new Date(Date.parse(startsAt) + duration * 60_000).toISOString();
      // An edit says "none" out loud — an absent field means "keep" to the
      // API. An unchanged room is left out, so a booking whose room was
      // archived since can still be edited.
      await appointmentsApi.update(a.id, {
        patientId,
        reason: reason.trim(),
        startsAt,
        endsAt,
        staffId: staffId || null,
        operatoryId:
          operatoryId === (a.operatoryId ?? '') ? undefined : operatoryId || null,
      });
      toast(`Saved ${patientName} — ${dayName(date)}, ${time}.`);
      const [y, m, d] = date.split('-').map(Number);
      onSaved(
        new Date(y!, m! - 1, d!, Number(time.slice(0, 2)), Number(time.slice(3, 5))),
      );
    } catch (err) {
      setError(humanError(err, 'The appointment could not be saved.'));
      setBusy(false);
    }
  }

  async function toggleHistory() {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    setShowHistory(true);
    if (history === null) {
      appointmentsApi
        .history(a.id)
        .then(setHistory)
        .catch(() => setHistory([]));
    }
  }

  /* ── what can be done now ──────────────────────────── */
  const primary = NEXT_STEP[a.status];
  const canMove = editable && (a.status === 'scheduled' || a.status === 'checked_in');
  // Messaging from the visit itself: a reminder before it, a follow-up after.
  const message = (purpose: 'appointment_reminder' | 'post_procedure_followup') => {
    onClose();
    openMessage({
      patientId: a.patientId,
      patientName: a.patientName,
      purpose,
      appointmentId: a.id,
    });
  };
  const upcoming = a.status === 'scheduled' && Date.parse(a.startsAt) > Date.now();
  const more: MoreItem[] = [
    ...(canMessage && upcoming
      ? [{ label: 'Send a reminder', onSelect: () => message('appointment_reminder') }]
      : []),
    ...(canMessage && a.status === 'completed'
      ? [
          {
            label: 'Send a follow-up',
            onSelect: () => message('post_procedure_followup'),
          },
        ]
      : []),
    ...(canWrite ? allowed : [])
      .filter((s) => s !== primary)
      .map((s) => ({
        label: stepLabel(a.status, s),
        danger: s === 'cancelled' || s === 'no_show',
        onSelect: () => (s === 'cancelled' ? setCancelling(true) : void move(s)),
      })),
  ];
  const staffLabel = a.staffName ?? 'Not assigned';
  const duration0 = minutesBetween(a.startsAt, a.endsAt);

  return (
    <SidePanel title={name} subtitle={fmtDateTime(a.startsAt)} onClose={onClose}>
      <div className="panel__form">
        <div className="panel__body">
          <div className="apptstate">
            <StatusPill status={a.status} />
            {a.rescheduledAt && (
              <span className="cell-sub">Moved {fmtStamp(a.rescheduledAt)}</span>
            )}
            {a.cancelReason && <span className="cell-sub">Reason: {a.cancelReason}</span>}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={toggleHistory}
              aria-expanded={showHistory}
            >
              <History size={14} aria-hidden /> {showHistory ? 'Hide history' : 'History'}
            </button>
          </div>

          {/* The one next step, then Move, then the rest behind More. */}
          {!cancelling &&
            (canWrite || more.length > 0) &&
            (primary || canMove || more.length > 0) && (
              <div className="visit__do">
                {canWrite && primary && allowed.includes(primary) && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={() => void move(primary)}
                  >
                    {stepLabel(a.status, primary)}
                  </button>
                )}
                {canMove && (
                  <button
                    type="button"
                    className={`btn btn--ghost${moving ? ' btn--active' : ''}`}
                    aria-expanded={moving}
                    onClick={() => setMoving((v) => !v)}
                  >
                    Move
                  </button>
                )}
                <MoreMenu label={`More for ${name}’s appointment`} items={more} />
              </div>
            )}

          {cancelling && (
            <div className="inlineform">
              <label className="field">
                <span>Why is this being cancelled? (required)</span>
                <input
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="Patient rescheduled, illness, clinic closure…"
                  autoFocus
                />
              </label>
              <div className="inlineform__foot">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setCancelling(false)}
                >
                  Keep appointment
                </button>
                <button
                  type="button"
                  className="btn btn--danger-ghost btn--sm"
                  disabled={busy || !cancelReason.trim()}
                  onClick={() => void move('cancelled', cancelReason.trim())}
                >
                  Cancel appointment
                </button>
              </div>
            </div>
          )}

          {moving && (
            <section
              className="panel__section visit__move"
              aria-label="Move to another time"
            >
              <h3 className="panel__section-title">Move to</h3>
              <TimeFinder
                duration={duration0}
                patientId={a.patientId}
                ignore={a.id}
                current={{ startsAt: a.startsAt, staffId: a.staffId }}
                staff={staff}
                whoId={whoId}
                onWho={setWhoId}
                preferOperatoryId={a.operatoryId ?? undefined}
                chosenStart={null}
                onChoose={(x) => void moveTo(x)}
                alert={alert}
                reloadKey={reloadKey}
                busy={busy}
              />
            </section>
          )}

          {showHistory && (
            <section className="panel__section" aria-label="Status history">
              <h3 className="panel__section-title">Status history</h3>
              {history === null ? (
                <p className="formhint">Loading…</p>
              ) : history.length === 0 ? (
                <p className="formhint">No changes recorded.</p>
              ) : (
                <ul className="eventlist">
                  {history.map((h) => (
                    <li key={h.id}>
                      <StatusPill status={h.toStatus} />
                      <span>
                        {h.fromStatus
                          ? `from ${t(`appt.status.${h.fromStatus}`)} · `
                          : 'created · '}
                        {h.actorName ?? 'Staff'} · {fmtStamp(h.createdAt)}
                        {h.note ? ` · ${h.note}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <dl className="summary">
            <div>
              <dt>Patient</dt>
              <dd>
                <Link to={`/patients/${a.patientId}`} className="table__link">
                  {name}
                </Link>
                {a.patientPhone && <span className="summary__sub">{a.patientPhone}</span>}
              </dd>
            </div>
            <div>
              <dt>For</dt>
              <dd>{a.reason}</dd>
            </div>
            <div>
              <dt>When</dt>
              <dd>
                {dayName(ymd(start))}
                <span className="summary__sub">
                  {fmtTime(a.startsAt)}–{fmtTime(a.endsAt)} · {duration0} min
                </span>
              </dd>
            </div>
            <div>
              <dt>With</dt>
              <dd>{staffLabel}</dd>
            </div>
            {(a.operatoryName || rooms.length > 0) && (
              <div>
                <dt>Room</dt>
                <dd>{a.operatoryName ?? 'No room'}</dd>
              </div>
            )}
          </dl>

          {editable && (
            <Disclosure
              summary="Details"
              hint="Patient, reason, exact time, dentist, room"
            >
              <PatientPicker
                canCreate={can('patients:write')}
                value={patientName}
                onPick={(p) => {
                  setPatientId(p.id);
                  setPatientName(`${p.firstName} ${p.lastName}`);
                }}
                onClear={() => {
                  setPatientId('');
                  setPatientName('');
                }}
              />
              <label className="field">
                <span>Reason</span>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={200}
                />
              </label>
              <WhenFields
                staff={staff}
                staffId={staffId}
                onStaff={setStaffId}
                previousStaff={
                  a.staffId
                    ? { id: a.staffId, name: a.staffName ?? 'Previous practitioner' }
                    : null
                }
                date={date}
                onDate={setDate}
                time={time}
                onTime={setTime}
                duration={duration}
                onDuration={setDuration}
                rooms={roomChoices}
                operatoryId={operatoryId}
                onRoom={setOperatoryId}
                check={check}
              />
              <TimeWarnings
                check={check}
                closedDay={closedOn(hours, date)}
                date={date}
                staffName={staff.find((s) => s.id === staffId)?.fullName ?? a.staffName}
                patientName={patientName}
                rooms={roomChoices}
                onFindTime={() => setMoving(true)}
                onRoom={setOperatoryId}
              />
              <div className="visit__save">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={busy}
                  onClick={() => void saveDetails()}
                >
                  {busy ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </Disclosure>
          )}

          <p className="formhint">
            <BellRing size={13} aria-hidden /> WhatsApp reminders are sent the day before
            from{' '}
            <Link to="/messages" className="table__link">
              Messages
            </Link>
            .
          </p>
        </div>

        <div className="panel__foot">
          {error && (
            <p className="formerror" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </SidePanel>
  );
}

/**
 * Booking and changing an appointment.
 *
 * A side panel rather than a centred modal: the calendar it was opened from
 * stays visible beside it on a desktop. On a phone it takes the whole screen.
 *
 * A new booking is three questions in the order a phone call goes — who,
 * what for, when — and the third is answered by the server: the soonest
 * times that will actually book, with the dentist and room chosen. Whatever
 * the system already knows (the patient from their record, the dentist and
 * time from a calendar slot, the length from the service) is never asked.
 * Every field is still there, under Details, for whoever needs it.
 *
 * An existing visit opens on its next step (Check in, Start, Complete), Move
 * — which is the same list of free times — and the rest under More.
 */
export default function AppointmentModal({
  appointment,
  startWith,
  ...rest
}: {
  /** A wall Date (lib/clinic-time): its local fields are the clinic's clock. */
  initialStart?: Date;
  initialOperatoryId?: string;
  /** Pre-selects the patient when booking from their record. */
  initialPatientId?: string;
  /** Pre-selects the practitioner when booking from their calendar column. */
  initialStaffId?: string;
  /** Pre-selects the service when booking from the service catalogue or search. */
  initialTreatmentId?: string;
  /** The start is only a hint of the day being looked at, not a chosen slot. */
  suggestedStart?: boolean;
  appointment?: Appointment;
  /** Open an existing visit straight on its free times. */
  startWith?: 'move';
  /** Who can be booked; loaded when not given. */
  staff?: StaffMember[];
  /** Offer "View" on the calendar after booking (when opened away from it). */
  offerView?: boolean;
  onClose: () => void;
  /** `at` is the saved start on the clinic's clock, so the calendar can go there. */
  onSaved: (at?: Date) => void;
}) {
  return appointment ? (
    <VisitPanel
      appointment={appointment}
      startWith={startWith}
      staff={rest.staff}
      onClose={rest.onClose}
      onSaved={rest.onSaved}
    />
  ) : (
    <BookPanel {...rest} />
  );
}
