import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, CalendarDays, BellRing } from 'lucide-react';
import {
  ApiError,
  appointmentsApi,
  remindersApi,
  type Reminder,
  type Appointment,
  type ApptStatus,
  type StaffMember,
} from '../lib/api';
import { Modal, PageHeader, EmptyState, StatusPill } from '../components/ui';
import PatientPicker from '../components/PatientPicker';

/* ── calendar constants ─────────────────────────────────── */
const DAY_START = 8;   // 08:00
const DAY_END = 20;    // 20:00
const HOUR_PX = 56;
const DURATIONS = [30, 45, 60, 90, 120];

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
function toLocalISO(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtRangeLabel(days: Date[]) {
  const f = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return days.length === 1
    ? days[0]!.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    : `${f(days[0]!)} – ${f(days[days.length - 1]!)}, ${days[0]!.getFullYear()}`;
}

/* ── page ───────────────────────────────────────────────── */
export default function ReservationsPage() {
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<'week' | 'day' | 'reminders'>(
    searchParams.get('view') === 'reminders' ? 'reminders' : 'week',
  );
  const [anchor, setAnchor] = useState(() => new Date());
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [creating, setCreating] = useState<{ start: Date } | null>(null);

  const days = useMemo(() => {
    if (view === 'day') {
      const d = new Date(anchor);
      d.setHours(0, 0, 0, 0);
      return [d];
    }
    const monday = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }, [view, anchor]);

  async function load() {
    setLoading(true);
    try {
      const from = days[0]!;
      const to = addDays(days[days.length - 1]!, 1);
      setAppts(await appointmentsApi.list({ from: from.toISOString(), to: to.toISOString() }));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0]?.getTime(), days.length]);

  const step = view === 'day' ? 1 : 7;
  const today = new Date();

  return (
    <div className="page">
      <PageHeader
        meta={view === 'reminders'
          ? 'Automatic and manual reminders for this clinic'
          : `${appts.filter((a) => a.status === 'scheduled').length} scheduled in view`}
        actions={
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
        }
        title={view === 'reminders' ? 'Reminder history' : (
          <span className="cal__nav">
            <button className="iconbtn" onClick={() => setAnchor(addDays(anchor, -step))} title="Previous">
              <ChevronLeft size={16} />
            </button>
            <button className="iconbtn" onClick={() => setAnchor(addDays(anchor, step))} title="Next">
              <ChevronRight size={16} />
            </button>
            <span className="cal__label">{fmtRangeLabel(days)}</span>
            <button className="btn btn--ghost btn--sm" onClick={() => setAnchor(new Date())}>
              Today
            </button>
          </span>
        )}
      />

      <div className="toolbar">
        <div className="tabs">
          <button className={`tab${view === 'day' ? ' tab--active' : ''}`} onClick={() => setView('day')}>Day</button>
          <button className={`tab${view === 'week' ? ' tab--active' : ''}`} onClick={() => setView('week')}>Week</button>
          <button className={`tab${view === 'reminders' ? ' tab--active' : ''}`} onClick={() => setView('reminders')}>Reminders</button>
        </div>
        {loading && <span className="muted" style={{ fontSize: 13 }}>Loading…</span>}
      </div>

      {view === 'reminders' ? (
        <ReminderLog />
      ) : !loading && appts.length === 0 ? (
        <EmptyState
          framed
          icon={<CalendarDays size={22} />}
          title="No appointments in this view"
          body="Click any time slot or use “New appointment” to book one."
        />
      ) : (
        <div className="cal">
          {/* header row */}
          <div className="cal__headrow" style={{ gridTemplateColumns: `64px repeat(${days.length}, 1fr)` }}>
            <div />
            {days.map((d) => (
              <div className="cal__daycol-head" key={d.toISOString()}>
                <div className="cal__dayname">{d.toLocaleDateString('en-GB', { weekday: 'short' })}</div>
                <div className={`cal__daynum${sameDay(d, today) ? ' cal__daynum--today' : ''}`}>{d.getDate()}</div>
              </div>
            ))}
          </div>
          {/* body */}
          <div className="cal__body" style={{ gridTemplateColumns: `64px repeat(${days.length}, 1fr)` }}>
            <div className="cal__times">
              {Array.from({ length: DAY_END - DAY_START }, (_, i) => (
                <div className="cal__hour" key={i}>{String(DAY_START + i).padStart(2, '0')}:00</div>
              ))}
            </div>
            {days.map((d) => (
              <DayColumn
                key={d.toISOString()}
                day={d}
                appts={appts.filter((a) => sameDay(new Date(a.startsAt), d))}
                onSlotClick={(start) => setCreating({ start })}
                onApptClick={setEditing}
              />
            ))}
          </div>
        </div>
      )}

      {(creating || editing) && (
        <AppointmentModal
          initialStart={creating?.start}
          appointment={editing ?? undefined}
          onClose={() => { setCreating(null); setEditing(null); }}
          onSaved={async () => { setCreating(null); setEditing(null); await load(); }}
        />
      )}
    </div>
  );
}

/* ── one day column ─────────────────────────────────────── */
function DayColumn({
  day,
  appts,
  onSlotClick,
  onApptClick,
}: {
  day: Date;
  appts: Appointment[];
  onSlotClick: (start: Date) => void;
  onApptClick: (a: Appointment) => void;
}) {
  const slots = (DAY_END - DAY_START) * 2; // half-hour slots
  return (
    <div className="cal__daycol" style={{ height: (DAY_END - DAY_START) * HOUR_PX }}>
      {Array.from({ length: slots }, (_, i) => {
        const start = new Date(day);
        start.setHours(DAY_START + Math.floor(i / 2), (i % 2) * 30, 0, 0);
        return <div className="cal__slot" key={i} onClick={() => onSlotClick(start)} />;
      })}
      {appts.map((a) => {
        const s = new Date(a.startsAt);
        const e = new Date(a.endsAt);
        const top = ((s.getHours() + s.getMinutes() / 60 - DAY_START) * HOUR_PX);
        const height = Math.max(24, ((e.getTime() - s.getTime()) / 3_600_000) * HOUR_PX - 3);
        return (
          <div
            key={a.id}
            className={`appt appt--${a.status}`}
            style={{ top, height }}
            onClick={(ev) => { ev.stopPropagation(); onApptClick(a); }}
            title={`${a.patientName} — ${a.reason}`}
          >
            <div className="appt__title">{a.patientName}</div>
            <div className="appt__sub">{fmtTime(a.startsAt)} · {a.reason}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ── create / edit modal ────────────────────────────────── */
function AppointmentModal({
  initialStart,
  appointment,
  onClose,
  onSaved,
}: {
  initialStart?: Date;
  appointment?: Appointment;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(appointment);
  const start = appointment ? new Date(appointment.startsAt) : (initialStart ?? new Date());
  const initialDuration = appointment
    ? Math.round((new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60000)
    : 45;

  const [patientId, setPatientId] = useState(appointment?.patientId ?? '');
  const [patientName, setPatientName] = useState(appointment?.patientName ?? '');
  const [staffId, setStaffId] = useState(appointment?.staffId ?? '');
  const [date, setDate] = useState(toLocalISO(start).slice(0, 10));
  const [time, setTime] = useState(toLocalISO(start).slice(11, 16));
  const [duration, setDuration] = useState(initialDuration);
  const [reason, setReason] = useState(appointment?.reason ?? '');
  const [status, setStatus] = useState<ApptStatus>(appointment?.status ?? 'scheduled');
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [sendingReminder, setSendingReminder] = useState(false);

  useEffect(() => {
    appointmentsApi.staff()
      .then((list) => setStaff(list.filter((s) => s.status === 'active')))
      .catch(() => setStaff([]));
    if (appointment) {
      remindersApi.list(appointment.id).then(setReminders).catch(() => setReminders([]));
    }
  }, [appointment]);

  async function sendReminderNow() {
    if (!appointment) return;
    setError(null);
    setSendingReminder(true);
    try {
      await remindersApi.sendManual(appointment.id);
      setReminders(await remindersApi.list(appointment.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the reminder.');
    } finally {
      setSendingReminder(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!patientId) { setError('Choose a patient'); return; }
    setError(null);
    setBusy(true);
    try {
      const startsAt = `${date}T${time}:00`;
      const endDate = new Date(`${date}T${time}:00`);
      endDate.setMinutes(endDate.getMinutes() + duration);
      const endsAt = toLocalISO(endDate);
      if (editing) {
        await appointmentsApi.update(appointment!.id, {
          patientId, staffId: staffId || undefined, startsAt, endsAt, reason, status,
        });
      } else {
        await appointmentsApi.create({ patientId, staffId: staffId || undefined, startsAt, endsAt, reason });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the appointment.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelAppointment() {
    if (!appointment) return;
    setBusy(true);
    try {
      await appointmentsApi.update(appointment.id, { status: 'cancelled' });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={editing ? 'Edit appointment' : 'New appointment'}
      subtitle={editing ? `${appointment!.patientName} · ${fmtTime(appointment!.startsAt)}` : undefined}
      onClose={onClose}
    >
      <form className="modal__body" onSubmit={submit}>
        <PatientPicker
          value={patientName}
          onPick={(p) => { setPatientId(p.id); setPatientName(`${p.firstName} ${p.lastName}`); }}
          onClear={() => { setPatientId(''); setPatientName(''); }}
        />
        <label className="field">
          <span>Practitioner</span>
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Unassigned</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>{s.fullName}</option>
            ))}
          </select>
        </label>
        <div className="grid2">
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>Start time</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Duration</span>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d} value={d}>{d} minutes</option>
              ))}
            </select>
          </label>
          {editing && (
            <label className="field">
              <span>Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as ApptStatus)}>
                <option value="scheduled">Scheduled</option>
                <option value="completed">Completed</option>
                <option value="no_show">No-show</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          )}
        </div>
        <label className="field">
          <span>Reason</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. General checkup, Root canal — session 2"
            required
            maxLength={200}
          />
        </label>

        {editing && (
          <div className="modal-reminders">
            <div className="modal-reminders__head">
              <span className="lineitems__title">Reminders</span>
              {appointment!.status === 'scheduled' && (
                <button type="button" className="btn btn--ghost btn--sm"
                  onClick={sendReminderNow} disabled={sendingReminder}>
                  <BellRing size={14} /> {sendingReminder ? 'Sending…' : 'Send reminder now'}
                </button>
              )}
            </div>
            {reminders === null ? (
              <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Loading…</p>
            ) : reminders.length === 0 ? (
              <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                No reminders yet for this appointment.
              </p>
            ) : (
              <ul className="modal-reminders__list">
                {reminders.map((r) => (
                  <li key={r.id}>
                    <StatusPill status={r.status === 'sent' ? 'completed' : r.status === 'failed' ? 'no_show' : 'scheduled'}
                      label={r.status === 'sent' ? 'Sent' : r.status === 'failed' ? 'Failed' : 'Pending'} />
                    <span>
                      {r.type === 'automatic' ? 'Automatic' : 'Manual'} · internal log ·{' '}
                      {r.sentAt ? new Date(r.sentAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && <p className="formerror">{error}</p>}

        <div className="modal__foot">
          {editing && appointment!.status === 'scheduled' && (
            <button type="button" className="btn btn--danger-ghost btn--sm" onClick={cancelAppointment} disabled={busy}>
              Cancel appointment
            </button>
          )}
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Close</button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Book appointment'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
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
        body="Automatic reminders appear here once enabled in Settings; manual reminders can be sent from any scheduled appointment."
      />
    );
  }
  return (
    <div className="card">
      <div className="card__head">
        <div>
          <h2>Reminder log</h2>
          <p className="card__sub">
            {items.length} entr{items.length === 1 ? 'y' : 'ies'} · delivery channel: internal log
            (no SMS/email provider connected yet)
          </p>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr><th>When</th><th>Patient</th><th>Appointment</th><th>Type</th><th>Status</th><th>Message</th></tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td className="muted">
                {new Date(r.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </td>
              <td style={{ fontWeight: 600 }}>{r.patientName}</td>
              <td className="muted">
                {r.appointmentReason}
                {r.appointmentStartsAt &&
                  ` · ${new Date(r.appointmentStartsAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
              </td>
              <td>
                <StatusPill status={r.type === 'automatic' ? 'info' : 'neutral'}
                  label={r.type === 'automatic' ? 'Automatic' : 'Manual'} />
              </td>
              <td>
                <StatusPill status={r.status === 'sent' ? 'completed' : r.status === 'failed' ? 'no_show' : 'scheduled'}
                  label={r.status === 'sent' ? 'Sent' : r.status === 'failed' ? 'Failed' : 'Pending'} />
              </td>
              <td className="muted" style={{ maxWidth: 320, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                title={r.message}>
                {r.message}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
