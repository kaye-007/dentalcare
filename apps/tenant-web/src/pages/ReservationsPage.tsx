import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, Plus, CalendarDays, BellRing, Filter, X,
} from 'lucide-react';
import {
  appointmentsApi,
  operatoriesApi,
  remindersApi,
  APPT_STATUSES,
  APPT_ACTIVE_STATUSES,
  type Reminder,
  type Appointment,
  type ApptStatus,
  type Operatory,
  type StaffMember,
} from '../lib/api';
import { PageHeader, EmptyState, StatusPill } from '../components/ui';
import AppointmentModal from '../components/AppointmentModal';
import { useAuth } from '../lib/auth';
import { dateLocale } from '../lib/i18n';
import { useT } from '../lib/i18n';

/* ── calendar constants ─────────────────────────────────── */
const DAY_START = 8;   // 08:00
const DAY_END = 20;    // 20:00
const HOUR_PX = 56;

type View = 'day' | 'week' | 'month' | 'reminders';

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
  return new Date(s).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
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
  const f = (d: Date) => d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
  if (days.length === 1) {
    return days[0]!.toLocaleDateString(dateLocale(), {
      weekday: 'long', day: 'numeric', month: 'long',
    });
  }
  return `${f(days[0]!)} – ${f(days[days.length - 1]!)}, ${days[0]!.getFullYear()}`;
}

/* ── page ───────────────────────────────────────────────── */
/**
 * Where "New appointment" lands when it is not opened from a slot: the next
 * hour boundary, today. The modal is editable, so this only has to be a sane
 * starting point rather than a guess at intent.
 */
function nextBookableSlot(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

export default function ReservationsPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const { can, readOnly } = useAuth();
  const canWrite = can('appointments:write');

  const [view, setView] = useState<View>(
    searchParams.get('view') === 'reminders' ? 'reminders' : 'week',
  );
  const [anchor, setAnchor] = useState(() => new Date());
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [creating, setCreating] = useState<{ start: Date; operatoryId?: string } | null>(null);

  // filters
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [rooms, setRooms] = useState<Operatory[]>([]);
  const [filterStaff, setFilterStaff] = useState('');
  const [filterRoom, setFilterRoom] = useState('');
  const [filterStatus, setFilterStatus] = useState<ApptStatus[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    appointmentsApi.staff()
      .then((list) => setStaff(list.filter((s) => s.status === 'active')))
      .catch(() => setStaff([]));
    operatoriesApi.list().then(setRooms).catch(() => setRooms([]));
  }, []);

  const days = useMemo(() => {
    if (view === 'day') {
      const d = new Date(anchor);
      d.setHours(0, 0, 0, 0);
      return [d];
    }
    if (view === 'month') return monthGrid(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));
  }, [view, anchor]);

  const load = useCallback(async () => {
    if (view === 'reminders' || days.length === 0) return;
    setLoading(true);
    try {
      setAppts(
        await appointmentsApi.list({
          from: days[0]!.toISOString(),
          to: addDays(days[days.length - 1]!, 1).toISOString(),
          staffId: filterStaff || undefined,
          operatoryId: filterRoom || undefined,
          status: filterStatus.length ? filterStatus : undefined,
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [view, days, filterStaff, filterRoom, filterStatus]);

  useEffect(() => { void load(); }, [load]);

  const step = view === 'day' ? 1 : 7;
  const shift = (dir: 1 | -1) => {
    if (view === 'month') {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    } else {
      setAnchor(addDays(anchor, dir * step));
    }
  };

  const today = new Date();
  const activeFilters =
    (filterStaff ? 1 : 0) + (filterRoom ? 1 : 0) + (filterStatus.length ? 1 : 0);
  const clearFilters = () => {
    setFilterStaff(''); setFilterRoom(''); setFilterStatus([]);
  };

  const toggleStatus = (s: ApptStatus) =>
    setFilterStatus((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div className="page">
      <PageHeader
        meta={
          view === 'reminders'
            ? 'Reminders handed to patients for this clinic'
            : `${appts.filter((a) => APPT_ACTIVE_STATUSES.includes(a.status)).length} active in view`
        }
        actions={
          canWrite && (
            <button
              className="btn btn--primary"
              onClick={() => {
                const d = new Date(anchor);
                d.setHours(9, 0, 0, 0);
                setCreating({ start: d });
              }}
            >
              <Plus size={16} /> New appointment
            </button>
          )
        }
        title={
          view === 'reminders' ? 'Reminder history' : (
            <span className="cal__nav">
              <button className="iconbtn" onClick={() => shift(-1)} title="Previous">
                <ChevronLeft size={16} />
              </button>
              <button className="iconbtn" onClick={() => shift(1)} title="Next">
                <ChevronRight size={16} />
              </button>
              <span className="cal__label">{rangeLabel(view, anchor, days)}</span>
              <button className="btn btn--ghost btn--sm" onClick={() => setAnchor(new Date())}>
                Today
              </button>
            </span>
          )
        }
      />

      <div className="toolbar">
        <div className="tabs">
          {(['day', 'week', 'month', 'reminders'] as View[]).map((v) => (
            <button
              key={v}
              className={`tab${view === v ? ' tab--active' : ''}`}
              onClick={() => setView(v)}
            >
              {v === 'reminders' ? 'Reminders' : v[0]!.toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        {view !== 'reminders' && (
          <button
            className={`btn btn--ghost btn--sm${activeFilters ? ' btn--active' : ''}`}
            onClick={() => setShowFilters((s) => !s)}
          >
            <Filter size={14} /> Filters{activeFilters ? ` (${activeFilters})` : ''}
          </button>
        )}
        {loading && <span className="muted" style={{ fontSize: 13 }}>Loading…</span>}
      </div>

      {showFilters && view !== 'reminders' && (
        <div className="filterbar">
          <label className="field field--inline">
            <span>Practitioner</span>
            <select value={filterStaff} onChange={(e) => setFilterStaff(e.target.value)}>
              <option value="">All practitioners</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>{s.fullName}</option>
              ))}
            </select>
          </label>
          <label className="field field--inline">
            <span>Room</span>
            <select value={filterRoom} onChange={(e) => setFilterRoom(e.target.value)}>
              <option value="">All rooms</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
          <div className="filterbar__statuses">
            <span className="cell-sub">Status</span>
            {APPT_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                className={`chip${filterStatus.includes(s) ? ' chip--on' : ''}`}
                onClick={() => toggleStatus(s)}
              >
                {t(`appt.status.${s}`)}
              </button>
            ))}
          </div>
          {activeFilters > 0 && (
            <button className="btn btn--ghost btn--sm" onClick={clearFilters}>
              <X size={13} /> Clear
            </button>
          )}
        </div>
      )}

      {view === 'reminders' ? (
        <ReminderLog />
      ) : view === 'month' ? (
        <MonthGrid
          days={days}
          anchor={anchor}
          appts={appts}
          today={today}
          onDayClick={(d) => { setAnchor(d); setView('day'); }}
          onApptClick={setEditing}
        />
      ) : !loading && appts.length === 0 ? (
        <EmptyState
          framed
          icon={<CalendarDays size={22} />}
          title={activeFilters ? 'Nothing matches these filters' : 'No appointments in this view'}
          body={
            activeFilters
              ? 'Try clearing a filter to see more.'
              : 'Click any time slot or use “New appointment” to book one.'
          }
          action={
            activeFilters ? (
              <button className="btn btn--ghost btn--sm" onClick={clearFilters}>Clear filters</button>
            ) : !readOnly ? (
              // Clicking a slot is the fast way once you know the calendar.
              // On an empty one there is no slot that looks clickable, which
              // is exactly when someone new needs a button that says so.
              <button
                className="btn btn--primary"
                onClick={() => setCreating({ start: nextBookableSlot() })}
              >
                <Plus size={16} /> Book an appointment
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="cal">
          <div
            className="cal__headrow"
            style={{ gridTemplateColumns: `64px repeat(${days.length}, 1fr)` }}
          >
            <div />
            {days.map((d) => (
              <div className="cal__daycol-head" key={d.toISOString()}>
                <div className="cal__dayname">
                  {d.toLocaleDateString(dateLocale(), { weekday: 'short' })}
                </div>
                <div className={`cal__daynum${sameDay(d, today) ? ' cal__daynum--today' : ''}`}>
                  {d.getDate()}
                </div>
              </div>
            ))}
          </div>
          <div
            className="cal__body"
            style={{ gridTemplateColumns: `64px repeat(${days.length}, 1fr)` }}
          >
            <div className="cal__times">
              {Array.from({ length: DAY_END - DAY_START }, (_, i) => (
                <div className="cal__hour" key={i}>
                  {String(DAY_START + i).padStart(2, '0')}:00
                </div>
              ))}
            </div>
            {days.map((d) => (
              <DayColumn
                key={d.toISOString()}
                day={d}
                appts={appts.filter((a) => sameDay(new Date(a.startsAt), d))}
                canWrite={canWrite}
                onSlotClick={(startAt) => setCreating({ start: startAt, operatoryId: filterRoom || undefined })}
                onApptClick={setEditing}
              />
            ))}
          </div>
        </div>
      )}

      {(creating || editing) && (
        <AppointmentModal
          initialStart={creating?.start}
          initialOperatoryId={creating?.operatoryId}
          appointment={editing ?? undefined}
          staff={staff}
          onClose={() => { setCreating(null); setEditing(null); }}
          onSaved={async () => { setCreating(null); setEditing(null); await load(); }}
        />
      )}
    </div>
  );
}

/* ── one day column (day + week views) ──────────────────── */
function DayColumn({
  day, appts, canWrite, onSlotClick, onApptClick,
}: {
  day: Date;
  appts: Appointment[];
  canWrite: boolean;
  onSlotClick: (start: Date) => void;
  onApptClick: (a: Appointment) => void;
}) {
  const slots = (DAY_END - DAY_START) * 2; // half-hour slots
  return (
    <div className="cal__daycol" style={{ height: (DAY_END - DAY_START) * HOUR_PX }}>
      {Array.from({ length: slots }, (_, i) => {
        const start = new Date(day);
        start.setHours(DAY_START + Math.floor(i / 2), (i % 2) * 30, 0, 0);
        return (
          <div
            className="cal__slot"
            key={i}
            onClick={canWrite ? () => onSlotClick(start) : undefined}
          />
        );
      })}
      {appts.map((a) => {
        const s = new Date(a.startsAt);
        const e = new Date(a.endsAt);
        const top = (s.getHours() + s.getMinutes() / 60 - DAY_START) * HOUR_PX;
        const height = Math.max(24, ((e.getTime() - s.getTime()) / 3_600_000) * HOUR_PX - 3);
        return (
          <div
            key={a.id}
            className={`appt appt--${a.status}`}
            style={{
              top,
              height,
              // The room's colour reads as a left edge so status still owns the fill.
              ...(a.operatoryColor ? { borderLeft: `3px solid ${a.operatoryColor}` } : {}),
            }}
            onClick={(ev) => { ev.stopPropagation(); onApptClick(a); }}
            title={`${a.patientName} — ${a.reason}${a.operatoryName ? ` · ${a.operatoryName}` : ''}`}
          >
            <div className="appt__title">{a.patientName}</div>
            <div className="appt__sub">
              {fmtTime(a.startsAt)} · {a.reason}
              {a.operatoryName ? ` · ${a.operatoryName}` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── month grid ─────────────────────────────────────────── */
function MonthGrid({
  days, anchor, appts, today, onDayClick, onApptClick,
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

  const weekdayNames = days.slice(0, 7).map((d) =>
    d.toLocaleDateString(dateLocale(), { weekday: 'short' }),
  );

  return (
    <div className="month">
      <div className="month__head">
        {weekdayNames.map((n) => (
          <div key={n} className="month__headcell">{n}</div>
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
              <div className="month__daynum">{d.getDate()}</div>
              {shown.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`month__appt month__appt--${a.status}`}
                  onClick={(ev) => { ev.stopPropagation(); onApptClick(a); }}
                  title={`${fmtTime(a.startsAt)} ${a.patientName} — ${a.reason}`}
                >
                  <span
                    className="month__dot"
                    style={a.operatoryColor ? { background: a.operatoryColor } : undefined}
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

/* ── tenant-wide reminder log ───────────────────────────── */
function ReminderLog() {
  const [items, setItems] = useState<Reminder[] | null>(null);
  useEffect(() => {
    remindersApi.list().then(setItems).catch(() => setItems([]));
  }, []);

  if (items === null) {
    return <div className="card"><div className="pad muted">Loading reminder log…</div></div>;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        framed
        icon={<BellRing size={22} />}
        title="No reminders yet"
        body="Open any scheduled appointment and use WhatsApp or Email to send one."
      />
    );
  }

  const channelLabel = (c: string) =>
    c === 'whatsapp' ? 'WhatsApp' : c === 'email' ? 'Email' : 'Internal log';

  return (
    <div className="card">
      <div className="card__head">
        <div>
          <h2>Reminder log</h2>
          <p className="card__sub">
            {items.length} entr{items.length === 1 ? 'y' : 'ies'}. WhatsApp and email
            reminders are opened in your own app, so this records that a message was
            prepared and handed off — not that the patient received it.
          </p>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>When</th><th>Patient</th><th>Appointment</th>
            <th>Channel</th><th>Type</th><th>Status</th><th>Message</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td className="muted">
                {new Date(r.createdAt).toLocaleString(dateLocale(), {
                  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                })}
              </td>
              <td style={{ fontWeight: 600 }}>{r.patientName}</td>
              <td className="muted">
                {r.appointmentReason}
                {r.appointmentStartsAt &&
                  ` · ${new Date(r.appointmentStartsAt).toLocaleString(dateLocale(), {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}`}
              </td>
              <td className="muted">{channelLabel(r.channel)}</td>
              <td>
                <StatusPill
                  status={r.type === 'automatic' ? 'info' : 'neutral'}
                  label={r.type === 'automatic' ? 'Automatic' : 'Manual'}
                />
              </td>
              <td>
                <StatusPill
                  status={r.status === 'sent' ? 'completed' : r.status === 'failed' ? 'no_show' : 'scheduled'}
                  label={r.status === 'sent' ? 'Handed off' : r.status === 'failed' ? 'Failed' : 'Pending'}
                />
              </td>
              <td
                className="muted"
                style={{ maxWidth: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                title={r.message}
              >
                {r.message}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
