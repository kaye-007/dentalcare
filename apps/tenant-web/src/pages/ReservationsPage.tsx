import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Filter,
  Plus,
  X,
} from 'lucide-react';
import {
  appointmentsApi,
  operatoriesApi,
  settingsApi,
  APPT_STATUSES,
  APPT_ACTIVE_STATUSES,
  type Appointment,
  type ApptStatus,
  type Operatory,
  type StaffMember,
  type WorkingDay,
} from '../lib/api';
import { Avatar, PageHeader } from '../components/ui';
import AppointmentModal from '../components/AppointmentModal';
import DayList from '../components/DayList';
import { useAuth } from '../lib/auth';
import { loadPractitioners } from '../lib/practitioners';
import { dateLocale } from '../lib/strings';
import { t } from '../lib/strings';
import { plural } from '../lib/format';
import { useMinute } from '../lib/useMinute';
import { fromWall, fromWallString, toWall, toWallString, wallNow } from '../lib/clinic-time';

/* ── calendar constants ─────────────────────────────────── */
/** Drawn when the clinic's opening hours are unknown. */
const DEFAULT_START = 8;
const DEFAULT_END = 20;
/**
 * Pixels per hour. 72 gives a 45-minute visit room for two lines; anything
 * shorter than COMPACT_PX drops to a single "time · name" line instead of
 * having its second line cut in half.
 */
const HOUR_PX = 72;
const COMPACT_PX = 44;

type View = 'list' | 'day' | 'week' | 'month';

/**
 * One column of the day view: a practitioner or a room, or the bookings that
 * have neither.
 */
interface DentistColumn {
  key: string;
  staffId?: string;
  operatoryId?: string;
  color?: string | null;
  name: string;
  sub: string | null;
}

/** How the day view splits into columns. */
type GroupBy = 'staff' | 'room';
const GROUP_KEY = 'dc.calendar.groupBy';
function savedGroupBy(): GroupBy {
  try {
    return localStorage.getItem(GROUP_KEY) === 'room' ? 'room' : 'staff';
  } catch {
    return 'staff';
  }
}

const VIEWS: { key: View; label: string }[] = [
  { key: 'list', label: 'List' },
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

/* ── date helpers ───────────────────────────────────────── */
function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function sameDay(a: Date, b: Date) {
  return a.toDateString() === b.toDateString();
}
function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString(dateLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
}
function fullDate(d: Date) {
  return d.toLocaleDateString(dateLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}
/** Hours since midnight, as a fraction. */
function hoursOf(d: Date) {
  return d.getHours() + d.getMinutes() / 60;
}
/** "08:30" → 8.5 */
function clockHours(s: string) {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) + (m ?? 0) / 60;
}
function clockLabel(hours: number) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
/** WorkingDay.day counts from Monday; Date.getDay() counts from Sunday. */
function workdayFor(hours: WorkingDay[] | null, d: Date) {
  return hours?.find((w) => w.day === (d.getDay() + 6) % 7) ?? null;
}

/**
 * The hours the grid draws: the clinic's opening hours, widened to take in
 * any booking in view. Drawing a fixed 08:00–20:00 showed a clinic that
 * closes at three o'clock five empty hours every afternoon — and hid a 07:30
 * emergency booking entirely.
 */
function visibleHours(hours: WorkingDay[] | null, appts: Appointment[]): [number, number] {
  let start = Infinity;
  let end = -Infinity;
  for (const w of hours ?? []) {
    if (w.closed) continue;
    start = Math.min(start, Math.floor(clockHours(w.open)));
    end = Math.max(end, Math.ceil(clockHours(w.close)));
  }
  if (!Number.isFinite(start)) {
    start = DEFAULT_START;
    end = DEFAULT_END;
  }
  for (const a of appts) {
    const s = new Date(a.startsAt);
    const e = new Date(a.endsAt);
    start = Math.min(start, Math.floor(hoursOf(s)));
    end = Math.max(end, sameDay(s, e) ? Math.ceil(hoursOf(e)) : 24);
  }
  start = Math.max(0, start);
  return [start, Math.min(24, Math.max(end, start + 1))];
}

interface Placed {
  appt: Appointment;
  top: number;
  height: number;
  lane: number;
  lanes: number;
}

/**
 * Where each card goes in a column. Bookings that overlap in time share the
 * width side by side instead of being painted over one another — with more
 * than one dentist, two patients at 09:00 is the normal case, not an error.
 */
function layoutColumn(appts: Appointment[], dayStart: number): Placed[] {
  const items = appts
    .map((appt) => {
      const s = new Date(appt.startsAt);
      const e = new Date(appt.endsAt);
      return {
        appt,
        startH: hoursOf(s),
        // A zero-length booking still needs somewhere to be clicked.
        endH: Math.max(sameDay(s, e) ? hoursOf(e) : 24, hoursOf(s) + 0.25),
      };
    })
    .sort((x, y) => x.startH - y.startH || y.endH - x.endH);

  const placed: Placed[] = [];
  let cluster: { item: (typeof items)[number]; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const lanes = laneEnds.length || 1;
    for (const { item, lane } of cluster) {
      placed.push({
        appt: item.appt,
        top: (item.startH - dayStart) * HOUR_PX,
        height: Math.max(22, (item.endH - item.startH) * HOUR_PX - 3),
        lane,
        lanes,
      });
    }
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const item of items) {
    if (item.startH >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= item.startH);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endH);
    } else {
      laneEnds[lane] = item.endH;
    }
    cluster.push({ item, lane });
    clusterEnd = Math.max(clusterEnd, item.endH);
  }
  flush();
  return placed;
}

/**
 * The six weeks a month grid shows: from the Monday on or before the 1st, to
 * the Sunday on or after the last day. Always 42 cells so the grid never
 * reflows between months.
 */
function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

function rangeLabel(view: View, anchor: Date, days: Date[]) {
  if (view === 'month') {
    return anchor.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' });
  }
  const f = (d: Date) =>
    d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
  if (days.length === 1) return fullDate(days[0]!);
  return `${f(days[0]!)} – ${f(days[days.length - 1]!)}, ${days[0]!.getFullYear()}`;
}

/* ── page ───────────────────────────────────────────────── */
/**
 * Where "New appointment" lands when it is not opened from a slot: the next
 * hour boundary, today. The panel is editable, so this only has to be a sane
 * starting point rather than a guess at intent.
 */
function nextBookableSlot(): Date {
  const d = wallNow();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/**
 * A seven-column week is unreadable at phone width, and a day of practitioner
 * columns scrolls sideways there — so a phone starts on today, as a list.
 */
function defaultCalendarView(): View {
  return window.matchMedia?.('(max-width: 760px)').matches ? 'list' : 'week';
}

export default function ReservationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { can, readOnly } = useAuth();
  const canWrite = can('appointments:write');
  const canReadSettings = can('settings:read');
  // The calendar works in wall Dates on the clinic's clock (lib/clinic-time):
  // appointments are converted as they arrive, and so is "now".
  const now = toWall(useMinute()).getTime();

  const [view, setView] = useState<View>(defaultCalendarView);
  const [groupBy, setGroupByState] = useState<GroupBy>(savedGroupBy);
  const setGroupBy = (g: GroupBy) => {
    setGroupByState(g);
    try {
      localStorage.setItem(GROUP_KEY, g);
    } catch {
      /* remembered for this visit only */
    }
  };
  const [anchor, setAnchor] = useState(wallNow);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [creating, setCreating] = useState<{
    start: Date;
    operatoryId?: string;
    patientId?: string;
    staffId?: string;
    /** The start is only a suggestion (the New button), not a slot someone clicked. */
    suggested?: boolean;
  } | null>(null);
  // The clinic's opening hours. Unknown (null) is a normal state — the grid
  // then draws the default day with nothing shaded.
  const [hours, setHours] = useState<WorkingDay[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef('');

  // filters
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [rooms, setRooms] = useState<Operatory[]>([]);
  const [filterStaff, setFilterStaff] = useState('');
  const [filterRoom, setFilterRoom] = useState('');
  const [filterStatus, setFilterStatus] = useState<ApptStatus[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    // Practitioners: active people who see patients (Staff → Sees patients).
    loadPractitioners()
      .then(setStaff)
      .catch(() => setStaff([]));
    operatoriesApi
      .list()
      .then(setRooms)
      .catch(() => setRooms([]));
  }, []);

  useEffect(() => {
    if (!canReadSettings) return;
    settingsApi
      .get()
      .then((s) => setHours(s.workingHours))
      .catch(() => setHours(null));
  }, [canReadSettings]);

  // Links from elsewhere in the app land here: an old link to the reminder
  // log (now Messages → Send history), and "New appointment" / "Book appointment" from the dashboard and a patient's
  // record. Each is acted on once and then taken out of the URL, so a reload
  // or Back does not open the panel a second time.
  useEffect(() => {
    const wantsReminders = searchParams.get('view') === 'reminders';
    const wantsNew = searchParams.get('new') === '1';
    // "?date=2026-09-28" (the dashboard's Coming up strip) opens that day.
    const wantsDate = searchParams.get('date');
    if (wantsDate && /^\d{4}-\d{2}-\d{2}$/.test(wantsDate)) {
      const [y, m, d] = wantsDate.split('-').map(Number);
      setAnchor(new Date(y!, m! - 1, d!, 12));
      setView(defaultCalendarView() === 'list' ? 'list' : 'day');
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('date');
          return next;
        },
        { replace: true },
      );
    }
    if (!wantsReminders && !wantsNew) return;

    if (wantsReminders) {
      navigate('/messages/history', { replace: true });
      return;
    }
    if (wantsNew) {
      if (canWrite && !readOnly) {
        setEditing(null);
        setCreating({
          start: nextBookableSlot(),
          suggested: true,
          patientId: searchParams.get('patient') ?? undefined,
        });
      }
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('view');
        next.delete('new');
        next.delete('patient');
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams, canWrite, readOnly, navigate]);

  const days = useMemo(() => {
    if (view === 'day' || view === 'list') {
      const d = new Date(anchor);
      d.setHours(0, 0, 0, 0);
      return [d];
    }
    if (view === 'month') return monthGrid(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));
  }, [view, anchor]);

  const load = useCallback(async () => {
    if (days.length === 0) return;
    setLoading(true);
    try {
      const list = await appointmentsApi.list({
        // The range is the clinic's days, from its midnight to its midnight.
        from: fromWall(days[0]!).toISOString(),
        to: fromWall(addDays(days[days.length - 1]!, 1)).toISOString(),
        staffId: filterStaff || undefined,
        operatoryId: filterRoom || undefined,
        status: filterStatus.length ? filterStatus : undefined,
      });
      setAppts(list.map((a) => ({ ...a, startsAt: toWallString(a.startsAt), endsAt: toWallString(a.endsAt) })));
    } finally {
      setLoading(false);
    }
  }, [days, filterStaff, filterRoom, filterStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const [startHour, endHour] = useMemo(() => visibleHours(hours, appts), [hours, appts]);

  // Open each new range scrolled to where the work is: the earliest booking
  // that has not finished yet, else the earliest booking at all, else the
  // current time on today, else opening time. Scrolling straight to "now"
  // was tried first — on a Sunday afternoon it hid every booking of the week
  // above the fold. Once per range, so a refresh after saving does not yank
  // the view away from the user.
  useEffect(() => {
    if (loading || (view !== 'day' && view !== 'week')) return;
    const key = `${view}|${days[0]?.toDateString()}`;
    if (scrolledFor.current === key) return;
    const el = scrollRef.current;
    if (!el) return;
    scrolledFor.current = key;
    const current = wallNow();
    const earliest = (list: Appointment[]) =>
      list.length ? Math.min(...list.map((a) => hoursOf(new Date(a.startsAt)))) : null;
    const live = appts.filter((a) => a.status !== 'cancelled');
    const unfinished = live.filter((a) => new Date(a.endsAt).getTime() > current.getTime());
    const target =
      earliest(unfinished) ??
      earliest(live) ??
      (days.some((d) => sameDay(d, current)) ? hoursOf(current) - 0.5 : startHour);
    // Land on an hour line, never between two. Scrolling to "half an hour
    // before the first appointment" put the grid mid-row, which sliced the
    // top card in half and read as a rendering fault rather than as scroll.
    const line = Math.max(startHour, Math.floor(target) - 1);
    el.scrollTop = Math.max(0, (line - startHour) * HOUR_PX);
  }, [loading, view, days, appts, startHour]);

  const step = view === 'day' || view === 'list' ? 1 : 7;
  const shift = (dir: 1 | -1) => {
    if (view === 'month') {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    } else {
      setAnchor(addDays(anchor, dir * step));
    }
  };

  const today = new Date(now);
  const activeFilters =
    (filterStaff ? 1 : 0) + (filterRoom ? 1 : 0) + (filterStatus.length ? 1 : 0);
  const clearFilters = () => {
    setFilterStaff('');
    setFilterRoom('');
    setFilterStatus([]);
  };

  const toggleStatus = (s: ApptStatus) =>
    setFilterStatus((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
    );

  const openDay = (d: Date) => {
    setAnchor(d);
    setView('day');
  };
  // The panel takes the appointment as the API has it: instants.
  const openAppointment = (a: Appointment) => {
    setCreating(null);
    setEditing({ ...a, startsAt: fromWallString(a.startsAt), endsAt: fromWallString(a.endsAt) });
  };

  // What the range holds, in words a receptionist uses. "0 active in view"
  // on a week of finished visits said nothing true about that week.
  const summary = useMemo(() => {
    const live = appts.filter((a) => a.status !== 'cancelled');
    return {
      booked: live.length,
      upcoming: live.filter(
        (a) => APPT_ACTIVE_STATUSES.includes(a.status) && new Date(a.endsAt).getTime() > now,
      ).length,
      completed: appts.filter((a) => a.status === 'completed').length,
      cancelled: appts.length - live.length,
    };
  }, [appts, now]);

  // The day view splits into one column per practitioner: everyone who sees
  // patients, anyone else holding a booking that day, and
  // "Unassigned" when a booking has nobody yet. With no one to split by, it
  // stays a single column.
  const byRoom = view === 'day' && groupBy === 'room' && rooms.length > 0;
  const dentistColumns = useMemo<DentistColumn[] | null>(() => {
    if (view !== 'day') return null;
    if (byRoom) {
      // One column per room, in the clinic's order, and "No room" for
      // bookings not yet placed in one.
      let list: DentistColumn[] = rooms.map((r) => ({
        key: r.id,
        operatoryId: r.id,
        color: r.color,
        name: r.name,
        sub: null,
      }));
      if (filterRoom) list = list.filter((c) => c.operatoryId === filterRoom);
      if (appts.some((a) => !a.operatoryId)) {
        list.push({ key: 'no-room', name: 'No room', sub: null });
      }
      return list;
    }
    const byId = new Map<string, DentistColumn>();
    for (const s of staff) {
      byId.set(s.id, { key: s.id, staffId: s.id, name: s.fullName, sub: s.position });
    }
    for (const a of appts) {
      if (a.staffId && !byId.has(a.staffId)) {
        byId.set(a.staffId, {
          key: a.staffId,
          staffId: a.staffId,
          name: a.staffName ?? 'Practitioner',
          sub: null,
        });
      }
    }
    let list = [...byId.values()];
    if (filterStaff) list = list.filter((c) => c.staffId === filterStaff);
    if (appts.some((a) => !a.staffId)) {
      list.push({ key: 'unassigned', name: 'Unassigned', sub: null });
    }
    return list.some((c) => c.staffId) ? list : null;
  }, [view, byRoom, rooms, staff, appts, filterStaff, filterRoom]);

  // A week of everyone's bookings is read as a list per day: three dentists
  // sharing a time-grid day column left each block a third of it wide
  // ("Lo… 09:…"). One dentist's week keeps the time grid, blocks full width.
  const weekAgenda = view === 'week' && !filterStaff && staff.length > 1;

  const columnCount = dentistColumns ? dentistColumns.length : days.length;
  const gridCols = `var(--cal-gutter) repeat(${columnCount}, minmax(0, 1fr))`;
  const apptsFor = (c: DentistColumn) =>
    byRoom
      ? appts.filter((a) => (c.operatoryId ? a.operatoryId === c.operatoryId : !a.operatoryId))
      : appts.filter((a) => (c.staffId ? a.staffId === c.staffId : !a.staffId));
  const bookedOn = (d: Date) =>
    appts.filter((a) => a.status !== 'cancelled' && sameDay(new Date(a.startsAt), d)).length;

  const hourRail = (
    <div className="cal__times" aria-hidden>
      {Array.from({ length: endHour - startHour }, (_, i) => (
        <div className="cal__hour" key={i}>
          {String(startHour + i).padStart(2, '0')}:00
        </div>
      ))}
    </div>
  );

  // A click in a room's column books that room; in a practitioner's column,
  // that practitioner (whose home room the form then fills in).
  const slotHandler = (c?: DentistColumn) => (startAt: Date) => {
    setEditing(null);
    setCreating({
      start: startAt,
      operatoryId: c?.operatoryId ?? (filterRoom || undefined),
      staffId: c?.staffId ?? (filterStaff || undefined),
    });
  };

  return (
    <div className="page page--wide">
      <PageHeader
        title={t('nav.reservations')}
        meta={
          loading && appts.length === 0
              ? 'Loading…'
              : `${plural(summary.booked, 'booking')} · ${summary.upcoming} still to come · ${summary.completed} completed${
                  summary.cancelled ? ` · ${summary.cancelled} cancelled` : ''
                }`
        }
        actions={
          canWrite && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                const d = new Date(anchor);
                d.setHours(9, 0, 0, 0);
                setEditing(null);
                setCreating({ start: d, suggested: true });
              }}
            >
              <Plus size={16} aria-hidden /> Book appointment
            </button>
          )
        }
      />

      <div className="calbar">
          <div className="calbar__nav">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setAnchor(wallNow())}
            >
              Today
            </button>
            <span className="calbar__step">
              <button
                type="button"
                className="iconbtn"
                onClick={() => shift(-1)}
                aria-label={`Previous ${view === 'list' ? 'day' : view}`}
                title="Previous"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                type="button"
                className="iconbtn"
                onClick={() => shift(1)}
                aria-label={`Next ${view === 'list' ? 'day' : view}`}
                title="Next"
              >
                <ChevronRight size={16} />
              </button>
            </span>
            <h2 className="calbar__label" aria-live="polite">
              {rangeLabel(view, anchor, days)}
            </h2>
            {loading && <span className="calbar__loading">Loading…</span>}
          </div>

        <div className="toolbar__group">
          <div className="tabs" role="group" aria-label="Calendar view">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                className={`tab${view === v.key ? ' tab--active' : ''}`}
                aria-pressed={view === v.key}
                onClick={() => setView(v.key)}
              >
                {v.label}
              </button>
            ))}
          </div>
          {/* Only a clinic with rooms has a second way to split the day. */}
          {view === 'day' && rooms.length > 0 && (
            <div className="tabs" role="group" aria-label="Columns">
              {(['staff', 'room'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  className={`tab${groupBy === g ? ' tab--active' : ''}`}
                  aria-pressed={groupBy === g}
                  onClick={() => setGroupBy(g)}
                >
                  {g === 'staff' ? 'By dentist' : 'By room'}
                </button>
              ))}
            </div>
          )}
          {(
            <button
              type="button"
              className={`btn btn--ghost btn--sm${activeFilters ? ' btn--active' : ''}`}
              aria-expanded={showFilters}
              aria-controls="calendar-filters"
              aria-label={`Filters${activeFilters ? `, ${activeFilters} active` : ''}`}
              onClick={() => setShowFilters((s) => !s)}
            >
              <Filter size={14} aria-hidden />
              <span className="calbar__filterlabel">Filters</span>
              {activeFilters ? ` (${activeFilters})` : ''}
            </button>
          )}
        </div>
      </div>

      {showFilters && (
        <div className="filterbar" id="calendar-filters">
          <label className="field field--inline">
            <span>Practitioner</span>
            <select value={filterStaff} onChange={(e) => setFilterStaff(e.target.value)}>
              <option value="">All practitioners</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}
                </option>
              ))}
            </select>
          </label>
          <label className="field field--inline">
            <span>Room</span>
            <select value={filterRoom} onChange={(e) => setFilterRoom(e.target.value)}>
              <option value="">All rooms</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <div className="filterbar__statuses" role="group" aria-label="Status">
            <span className="filterbar__label">Status</span>
            {APPT_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                className={`chip${filterStatus.includes(s) ? ' chip--on' : ''}`}
                aria-pressed={filterStatus.includes(s)}
                onClick={() => toggleStatus(s)}
              >
                {t(`appt.status.${s}`)}
              </button>
            ))}
          </div>
          {activeFilters > 0 && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={clearFilters}>
              <X size={13} aria-hidden /> Clear
            </button>
          )}
        </div>
      )}

      {/* An empty range keeps its grid. The time slots are the fastest way to
          book, so they stay on screen; this line says what is going on and
          offers the button for anyone who has not found them yet. */}
      {!loading && appts.length === 0 && view !== 'list' && (
        <div className="calnotice" role="status">
          <CalendarDays size={16} aria-hidden />
          <span className="calnotice__text">
            {activeFilters
              ? 'Nothing matches these filters.'
              : view === 'day' && workdayFor(hours, days[0]!)?.closed
                ? `The clinic is closed on ${days[0]!.toLocaleDateString(dateLocale(), { weekday: 'long' })}s.${
                    canWrite ? ' “Book appointment” still takes any day and time.' : ''
                  }`
                : canWrite && !weekAgenda
                  ? 'No appointments in this view. Click any open time slot to book one.'
                  : 'No appointments in this view.'}
          </span>
          {activeFilters ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={clearFilters}>
              Clear filters
            </button>
          ) : !readOnly && canWrite ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setEditing(null);
                setCreating({ start: nextBookableSlot(), suggested: true });
              }}
            >
              <Plus size={14} aria-hidden /> Book appointment
            </button>
          ) : null}
        </div>
      )}

      {/* Whose week: everyone as a list per day, or one dentist on the grid. */}
      {view === 'week' && staff.length > 1 && (
        <div className="calwho" role="group" aria-label="Practitioner">
          <button
            type="button"
            className={`chip${!filterStaff ? ' chip--on' : ''}`}
            aria-pressed={!filterStaff}
            onClick={() => setFilterStaff('')}
          >
            Everyone
          </button>
          {staff.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`chip${filterStaff === s.id ? ' chip--on' : ''}`}
              aria-pressed={filterStaff === s.id}
              onClick={() => setFilterStaff(s.id)}
            >
              {s.fullName}
            </button>
          ))}
        </div>
      )}

      {view === 'list' ? (
        <DayList
          day={days[0]!}
          appts={appts}
          staff={staff}
          filterStaff={filterStaff}
          onFilterStaff={setFilterStaff}
          now={now}
          canWrite={canWrite && !readOnly}
          canBill={can('invoices:write') && !readOnly}
          closed={Boolean(workdayFor(hours, days[0]!)?.closed)}
          onOpen={openAppointment}
          onBook={() => {
            const d = new Date(days[0]!);
            d.setHours(9, 0, 0, 0);
            setEditing(null);
            setCreating({ start: d, suggested: true, staffId: filterStaff || undefined });
          }}
          onChanged={() => void load()}
        />
      ) : weekAgenda ? (
        <WeekAgenda
          days={days}
          appts={appts}
          hours={hours}
          today={today}
          onDayClick={openDay}
          onApptClick={openAppointment}
        />
      ) : view === 'month' ? (
        <MonthGrid
          days={days}
          anchor={anchor}
          appts={appts}
          today={today}
          onDayClick={openDay}
          onApptClick={openAppointment}
        />
      ) : (
        <div className="cal" style={{ ['--hour' as string]: `${HOUR_PX}px` }}>
          {/* The grid scrolls inside itself, so the day headings and the
              hour gutter stay in view however far down or across you go. */}
          <div className="cal__scroll" ref={scrollRef}>
            <div
              className={`cal__inner${!dentistColumns && days.length > 1 ? ' cal__inner--week' : ''}`}
              style={
                dentistColumns
                  ? { minWidth: `calc(var(--cal-gutter) + ${dentistColumns.length * 190}px)` }
                  : undefined
              }
            >
              <div className="cal__headrow" style={{ gridTemplateColumns: gridCols }}>
                <div aria-hidden />
                {dentistColumns
                  ? dentistColumns.map((c) => {
                      const booked = apptsFor(c).filter((a) => a.status !== 'cancelled').length;
                      return (
                        <div className="cal__staffhead" key={c.key}>
                          {byRoom ? (
                            <span
                              className="cal__roomdot"
                              style={c.color ? { background: c.color } : undefined}
                              aria-hidden
                            />
                          ) : (
                            <Avatar name={c.name} size={30} />
                          )}
                          <span className="cal__staffmeta">
                            <span className="cal__staffname" title={c.name}>
                              {c.name}
                            </span>
                            <span className="cal__staffsub">
                              {plural(booked, 'appointment')}
                              {c.sub ? ` · ${c.sub}` : ''}
                            </span>
                          </span>
                        </div>
                      );
                    })
                  : days.map((d) => {
                      const isToday = sameDay(d, today);
                      const closed = workdayFor(hours, d)?.closed ?? false;
                      const booked = bookedOn(d);
                      const label = (
                        <>
                          <span className="cal__dayname">
                            {d.toLocaleDateString(dateLocale(), { weekday: 'short' })}
                          </span>
                          <span
                            className={`cal__daynum${isToday ? ' cal__daynum--today' : ''}`}
                          >
                            {d.getDate()}
                          </span>
                          <span className="cal__daymeta">
                            {booked > 0 ? `${booked} booked` : closed ? 'Closed' : ''}
                          </span>
                        </>
                      );
                      // In a week, a day heading opens that day.
                      return days.length > 1 ? (
                        <button
                          type="button"
                          className={`cal__daycol-head${closed ? ' cal__daycol-head--closed' : ''}`}
                          key={d.toISOString()}
                          onClick={() => openDay(d)}
                          aria-label={`Open ${fullDate(d)}${closed ? ', clinic closed' : ''}${
                            booked ? `, ${plural(booked, 'booking')}` : ''
                          }`}
                          aria-current={isToday ? 'date' : undefined}
                        >
                          {label}
                        </button>
                      ) : (
                        <div
                          className={`cal__daycol-head${closed ? ' cal__daycol-head--closed' : ''}`}
                          key={d.toISOString()}
                          aria-current={isToday ? 'date' : undefined}
                        >
                          {label}
                        </div>
                      );
                    })}
              </div>

              <div className="cal__body" style={{ gridTemplateColumns: gridCols }}>
                {hourRail}
                {dentistColumns
                  ? dentistColumns.map((c) => (
                      <DayColumn
                        key={c.key}
                        day={days[0]!}
                        now={now}
                        startHour={startHour}
                        endHour={endHour}
                        workday={workdayFor(hours, days[0]!)}
                        detailed
                        byRoom={byRoom}
                        appts={apptsFor(c)}
                        canWrite={canWrite}
                        onSlotClick={slotHandler(c)}
                        onApptClick={openAppointment}
                      />
                    ))
                  : days.map((d) => (
                      <DayColumn
                        key={d.toISOString()}
                        day={d}
                        now={now}
                        startHour={startHour}
                        endHour={endHour}
                        workday={workdayFor(hours, d)}
                        detailed={view === 'day'}
                        appts={appts.filter((a) => sameDay(new Date(a.startsAt), d))}
                        canWrite={canWrite}
                        onSlotClick={slotHandler()}
                        onApptClick={openAppointment}
                      />
                    ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {(creating || editing) && (
        <AppointmentModal
          key={editing?.id ?? 'new'}
          initialStart={creating?.start}
          initialOperatoryId={creating?.operatoryId}
          initialPatientId={creating?.patientId}
          initialStaffId={creating?.staffId}
          suggestedStart={creating?.suggested}
          appointment={editing ?? undefined}
          staff={staff}
          onClose={() => {
            setCreating(null);
            setEditing(null);
          }}
          onSaved={async (at?: Date) => {
            setCreating(null);
            setEditing(null);
            // Show the day the visit landed on, not the one the panel opened from.
            if (at && !days.some((d) => sameDay(d, at))) setAnchor(at);
            else await load();
          }}
        />
      )}
    </div>
  );
}

/* ── week, everyone: one list per day ───────────────────── */
function initialsOf(name: string | null | undefined) {
  if (!name) return '';
  return name
    .replace(/^Dr\.?\s+/i, '')
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function WeekAgenda({
  days,
  appts,
  hours,
  today,
  onDayClick,
  onApptClick,
}: {
  days: Date[];
  appts: Appointment[];
  hours: WorkingDay[] | null;
  today: Date;
  onDayClick: (d: Date) => void;
  onApptClick: (a: Appointment) => void;
}) {
  return (
    <div className="weekagenda">
      {days.map((d) => {
        const list = appts
          .filter((a) => sameDay(new Date(a.startsAt), d))
          .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
        const live = list.filter((a) => a.status !== 'cancelled').length;
        const closed = workdayFor(hours, d)?.closed ?? false;
        const isToday = sameDay(d, today);
        return (
          <section
            key={d.toISOString()}
            className={`weekagenda__day${isToday ? ' weekagenda__day--today' : ''}`}
            aria-label={fullDate(d)}
          >
            <button
              type="button"
              className="weekagenda__head"
              onClick={() => onDayClick(d)}
              aria-label={`Open ${fullDate(d)}${live ? `, ${plural(live, 'booking')}` : ''}`}
              aria-current={isToday ? 'date' : undefined}
            >
              <span className="cal__dayname">
                {d.toLocaleDateString(dateLocale(), { weekday: 'short' })}
              </span>
              <span className={`cal__daynum${isToday ? ' cal__daynum--today' : ''}`}>
                {d.getDate()}
              </span>
              <span className="cal__daymeta">
                {live > 0 ? `${live} booked` : closed ? 'Closed' : 'Free'}
              </span>
            </button>
            {list.length > 0 && (
              <ol className="weekagenda__list">
                {list.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className={`weekagenda__item weekagenda__item--${a.status}`}
                      style={a.operatoryColor ? { borderLeftColor: a.operatoryColor } : undefined}
                      onClick={() => onApptClick(a)}
                      aria-label={`${fmtTime(a.startsAt)} ${a.patientName}, ${a.reason}${
                        a.staffName ? `, ${a.staffName}` : ''
                      }, ${t(`appt.status.${a.status}`)}`}
                      title={`${fmtTime(a.startsAt)}–${fmtTime(a.endsAt)} ${a.patientName} — ${a.reason}${
                        a.staffName ? ` · ${a.staffName}` : ''
                      }`}
                    >
                      <span className="weekagenda__time">{fmtTime(a.startsAt)}</span>
                      <span className="weekagenda__who">{a.patientName}</span>
                      <span className="weekagenda__doc" aria-hidden>
                        {initialsOf(a.staffName)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ── one day column (day + week views) ──────────────────── */
function DayColumn({
  day,
  now,
  startHour,
  endHour,
  workday,
  detailed = false,
  byRoom = false,
  appts,
  canWrite,
  onSlotClick,
  onApptClick,
}: {
  day: Date;
  now: number;
  startHour: number;
  endHour: number;
  /** The clinic's hours for this weekday, when known. */
  workday: WorkingDay | null;
  /** Wide enough for a status badge and a reason tag (day views). */
  detailed?: boolean;
  /** Columns are rooms, so each booking names its practitioner instead. */
  byRoom?: boolean;
  appts: Appointment[];
  canWrite: boolean;
  onSlotClick: (start: Date) => void;
  onApptClick: (a: Appointment) => void;
}) {
  const slots = (endHour - startHour) * 2; // half-hour slots
  const current = new Date(now);
  const isToday = sameDay(day, current);
  const nowHours = hoursOf(current);
  const showNow = isToday && nowHours >= startHour && nowHours <= endHour;

  const closed = workday?.closed ?? false;
  const openH = workday && !workday.closed ? clockHours(workday.open) : null;
  const closeH = workday && !workday.closed ? clockHours(workday.close) : null;
  // A slot books with one click only inside opening hours. Outside them the
  // panel still takes any time; the grid just stops inviting it.
  const bookable = (h: number) =>
    canWrite && !closed && (openH === null || (h >= openH && h < (closeH ?? 24)));

  const placed = useMemo(() => layoutColumn(appts, startHour), [appts, startHour]);

  return (
    <div
      className={`cal__daycol${isToday ? ' cal__daycol--today' : ''}${
        closed ? ' cal__daycol--closed' : ''
      }`}
      style={{ height: (endHour - startHour) * HOUR_PX }}
    >
      {Array.from({ length: slots }, (_, i) => {
        const h = startHour + i / 2;
        const start = new Date(day);
        start.setHours(Math.floor(h), (i % 2) * 30, 0, 0);
        const open = bookable(h);
        return (
          <div
            className={`cal__slot${open ? ' cal__slot--open' : ''}`}
            key={i}
            data-label={open ? `+ ${clockLabel(h)}` : undefined}
            onClick={open ? () => onSlotClick(start) : undefined}
          />
        );
      })}

      {openH !== null && openH > startHour && (
        <div
          className="cal__offhours"
          style={{ top: 0, height: (openH - startHour) * HOUR_PX }}
          aria-hidden
        />
      )}
      {closeH !== null && closeH < endHour && (
        <div
          className="cal__offhours"
          style={{ top: (closeH - startHour) * HOUR_PX, bottom: 0 }}
          aria-hidden
        />
      )}

      {showNow && (
        <div
          className="cal__now"
          style={{ top: (nowHours - startHour) * HOUR_PX }}
          aria-hidden
        />
      )}

      {placed.map(({ appt: a, top, height, lane, lanes }) => {
        const compact = height < COMPACT_PX;
        // A block sharing a narrow week column with others has room for one
        // thing. The grid already says the time; the name gets the space.
        const narrow = !detailed && lanes > 1;
        return (
          <button
            key={a.id}
            type="button"
            className={`appt appt--${a.status}${compact ? ' appt--compact' : ''}${narrow ? ' appt--narrow' : ''}`}
            style={{
              top,
              height,
              left: `calc(${(lane / lanes) * 100}% + 3px)`,
              width: `calc(${100 / lanes}% - 6px)`,
              right: 'auto',
              // The room's colour reads as a left edge so status still owns the fill.
              ...(a.operatoryColor ? { borderLeftColor: a.operatoryColor } : {}),
            }}
            onClick={(ev) => {
              ev.stopPropagation();
              onApptClick(a);
            }}
            title={`${fmtTime(a.startsAt)}–${fmtTime(a.endsAt)} ${a.patientName} — ${a.reason}${
              a.staffName ? ` · ${a.staffName}` : ''
            }${a.operatoryName ? ` · ${a.operatoryName}` : ''} (${t(`appt.status.${a.status}`)})`}
            aria-label={`${fmtTime(a.startsAt)} ${a.patientName}, ${a.reason}, ${t(`appt.status.${a.status}`)}`}
          >
            {narrow ? (
              <span className="appt__title">{a.patientName}</span>
            ) : compact ? (
              <span className="appt__line">
                <span className="appt__time">{fmtTime(a.startsAt)}</span>
                <span className="appt__title">{a.patientName}</span>
                {/* A day-view column is wide enough to say why on the same line. */}
                {detailed && <span className="appt__reason">{a.reason}</span>}
              </span>
            ) : detailed ? (
              <>
                <span className="appt__row">
                  <span className="appt__title">{a.patientName}</span>
                  {/* "Scheduled" is what a booking is; only the exceptions speak. */}
                  {a.status !== 'scheduled' && (
                    <span className="appt__status">{t(`appt.status.${a.status}`)}</span>
                  )}
                </span>
                <span className="appt__sub">
                  {fmtTime(a.startsAt)}–{fmtTime(a.endsAt)}
                  {/* The column already says the room (or the dentist); name the other. */}
                  {byRoom
                    ? a.staffName ? ` · ${a.staffName}` : ''
                    : a.operatoryName ? ` · ${a.operatoryName}` : ''}
                </span>
                {height >= 64 && <span className="appt__tag">{a.reason}</span>}
              </>
            ) : (
              <>
                <span className="appt__title">{a.patientName}</span>
                <span className="appt__sub">
                  {fmtTime(a.startsAt)} · {a.reason}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── month grid ─────────────────────────────────────────── */
function MonthGrid({
  days,
  anchor,
  appts,
  today,
  onDayClick,
  onApptClick,
}: {
  days: Date[];
  anchor: Date;
  appts: Appointment[];
  today: Date;
  onDayClick: (d: Date) => void;
  onApptClick: (a: Appointment) => void;
}) {
  const byDay = useMemo(() => {
    const m = new Map<string, Appointment[]>();
    for (const a of appts) {
      const key = new Date(a.startsAt).toDateString();
      const list = m.get(key);
      if (list) list.push(a);
      else m.set(key, [a]);
    }
    for (const list of m.values()) {
      list.sort((x, y) => x.startsAt.localeCompare(y.startsAt));
    }
    return m;
  }, [appts]);

  const weekdayNames = days
    .slice(0, 7)
    .map((d) => d.toLocaleDateString(dateLocale(), { weekday: 'short' }));

  return (
    <div className="month">
      <div className="month__head" aria-hidden>
        {weekdayNames.map((n) => (
          <div key={n} className="month__headcell">
            {n}
          </div>
        ))}
      </div>
      <div className="month__grid">
        {days.map((d) => {
          const list = byDay.get(d.toDateString()) ?? [];
          const outside = d.getMonth() !== anchor.getMonth();
          const shown = list.slice(0, 3);
          return (
            <div
              key={d.toISOString()}
              className={`month__cell${outside ? ' month__cell--outside' : ''}${
                sameDay(d, today) ? ' month__cell--today' : ''
              }`}
              onClick={() => onDayClick(d)}
            >
              {/* The keyboard way into a day; the whole cell stays clickable. */}
              <button
                type="button"
                className="month__daynum"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onDayClick(d);
                }}
                aria-label={`Open ${fullDate(d)}${list.length ? `, ${list.length} appointments` : ''}`}
              >
                {d.getDate()}
              </button>
              {shown.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`month__appt month__appt--${a.status}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onApptClick(a);
                  }}
                  title={`${fmtTime(a.startsAt)} ${a.patientName} — ${a.reason}`}
                >
                  <span
                    className="month__dot"
                    style={
                      a.operatoryColor ? { background: a.operatoryColor } : undefined
                    }
                  />
                  <span className="month__appttime">{fmtTime(a.startsAt)}</span>
                  <span className="month__apptname">{a.patientName}</span>
                </button>
              ))}
              {list.length > shown.length && (
                <span className="month__more">+{list.length - shown.length} more</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

