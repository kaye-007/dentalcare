import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DoorOpen, Plus, Trash2, X, CalendarClock } from 'lucide-react';
import {
  ApiError,
  appointmentsApi,
  availabilityApi,
  operatoriesApi,
  type AvailabilityEntry,
  type Operatory,
  type StaffMember,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader, EmptyState, StatusPill } from '../components/ui';

/**
 * Clinic capacity: the rooms treatment happens in, and when each practitioner
 * works. Both feed the scheduler — rooms become bookable resources, hours
 * drive the free-slot finder.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Monday-first for display; the stored value stays JS-native (0 = Sunday). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const PRESET_COLORS = ['#2f6f62', '#3a6ea5', '#8a5cf6', '#c2410c', '#0f766e', '#9a3412'];

export default function RoomsPage() {
  const { can, user } = useAuth();
  const canManageRooms = can('operatories:manage');
  const canManageAnyone = can('availability:manage');

  const [rooms, setRooms] = useState<Operatory[] | null>(null);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [availability, setAvailability] = useState<AvailabilityEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addingRoom, setAddingRoom] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([
        operatoriesApi.list(true),
        availabilityApi.list(),
      ]);
      setRooms(r);
      setAvailability(a);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setRooms([]);
    }
  }, []);

  useEffect(() => {
    void load();
    appointmentsApi.staff()
      .then((l) => setStaff(l.filter((s) => s.status === 'active')))
      .catch(() => setStaff([]));
  }, [load]);

  async function removeRoom(room: Operatory) {
    setError(null);
    setNotice(null);
    try {
      const res = await operatoriesApi.remove(room.id);
      setNotice(
        res.deactivated
          ? `"${room.name}" is used by ${res.appointmentsUsingRoom} appointment(s), so it was retired rather than deleted. Its history is intact.`
          : `"${room.name}" deleted.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove the room.');
    }
  }

  async function toggleRoom(room: Operatory) {
    setError(null);
    try {
      await operatoriesApi.update(room.id, { isActive: !room.isActive });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not update the room.');
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Rooms & working hours"
        meta="Treatment rooms and practitioner schedules used by the calendar"
      />

      {error && <p className="formerror">{error}</p>}
      {notice && <p className="muted" style={{ fontSize: 13 }}>{notice}</p>}

      <div className="grid">
        {/* ── rooms ── */}
        <div className="card span-12">
          <header className="card__head">
            <h3><DoorOpen size={16} aria-hidden /> Treatment rooms</h3>
            {canManageRooms && !addingRoom && (
              <button className="btn btn--ghost btn--sm" onClick={() => setAddingRoom(true)}>
                <Plus size={14} /> Add room
              </button>
            )}
          </header>

          {addingRoom && (
            <RoomForm
              onDone={() => { setAddingRoom(false); void load(); }}
              onCancel={() => setAddingRoom(false)}
            />
          )}

          {rooms === null ? (
            <p className="muted">Loading rooms…</p>
          ) : rooms.length === 0 && !addingRoom ? (
            <EmptyState
              icon={<DoorOpen size={20} />}
              title="No rooms yet"
              body={
                canManageRooms
                  ? 'Add a room to assign appointments to a chair. The calendar prevents two patients being booked into the same room at once.'
                  : 'No treatment rooms have been set up.'
              }
            />
          ) : (
            <ul className="recordlist">
              {rooms.map((r) => (
                <li key={r.id} className={`recordrow${r.isActive ? '' : ' recordrow--muted'}`}>
                  <div className="recordrow__main">
                    <span
                      className="month__dot"
                      style={r.color ? { background: r.color } : undefined}
                    />
                    <span className="recordrow__title">{r.name}</span>
                    <StatusPill status={r.isActive ? 'active' : 'inactive'} />
                    {r.description && <span className="cell-sub">{r.description}</span>}
                  </div>
                  {canManageRooms && (
                    <div className="recordrow__actions">
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => toggleRoom(r)}
                      >
                        {r.isActive ? 'Retire' : 'Reinstate'}
                      </button>
                      <button
                        className="iconbtn"
                        onClick={() => removeRoom(r)}
                        aria-label={`Remove ${r.name}`}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── availability ── */}
        <div className="card span-12">
          <header className="card__head">
            <h3><CalendarClock size={16} aria-hidden /> Working hours</h3>
          </header>
          <p className="muted" style={{ fontSize: 12.5, margin: '0 0 14px' }}>
            Times are clinic-local. Everyone can edit their own hours; changing
            someone else's needs administrator access.
          </p>

          {staff.length === 0 ? (
            <p className="muted">Loading staff…</p>
          ) : (
            staff.map((s) => (
              <StaffSchedule
                key={s.id}
                staff={s}
                rooms={(rooms ?? []).filter((r) => r.isActive)}
                entries={availability.filter((a) => a.staffId === s.id)}
                canEdit={canManageAnyone || user?.id === s.id}
                onChange={load}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ── new room form ──────────────────────────────────────── */
function RoomForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await operatoriesApi.create({
        name: name.trim(),
        description: description.trim() || undefined,
        color,
      });
      onDone();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not create the room.');
      setBusy(false);
    }
  }

  return (
    <form className="inlineform" onSubmit={submit}>
      <div className="grid2">
        <label className="field"><span>Room name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Surgery 1, Hygiene bay…"
            autoFocus
            required
          /></label>
        <label className="field"><span>Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          /></label>
      </div>
      <div className="field">
        <span>Calendar colour</span>
        <div className="sendrow">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch${color === c ? ' swatch--on' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`Colour ${c}`}
            />
          ))}
        </div>
      </div>
      {err && <p className="formerror">{err}</p>}
      <div className="inlineform__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn--primary btn--sm" disabled={busy}>
          {busy ? 'Saving…' : 'Add room'}
        </button>
      </div>
    </form>
  );
}

/* ── one practitioner's week ────────────────────────────── */
function StaffSchedule({
  staff, rooms, entries, canEdit, onChange,
}: {
  staff: StaffMember;
  rooms: Operatory[];
  entries: AvailabilityEntry[];
  canEdit: boolean;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [weekday, setWeekday] = useState(1);
  const [startsAt, setStartsAt] = useState('09:00');
  const [endsAt, setEndsAt] = useState('17:00');
  const [operatoryId, setOperatoryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await availabilityApi.create({
        staffId: staff.id,
        weekday,
        startsAt,
        endsAt,
        operatoryId: operatoryId || undefined,
      });
      setAdding(false);
      onChange();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not save those hours.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setErr(null);
    try {
      await availabilityApi.remove(id);
      onChange();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not remove that shift.');
    }
  }

  return (
    <div className="schedule">
      <div className="schedule__head">
        <span className="recordrow__title">
          {staff.fullName}
          {staff.position && <span className="cell-sub"> · {staff.position}</span>}
        </span>
        {canEdit && !adding && (
          <button className="btn btn--ghost btn--sm" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add hours
          </button>
        )}
      </div>

      {adding && (
        <form className="inlineform" onSubmit={add}>
          <div className="grid2">
            <label className="field"><span>Day</span>
              <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {WEEK_ORDER.map((d) => (
                  <option key={d} value={d}>{WEEKDAYS[d]}</option>
                ))}
              </select></label>
            <label className="field"><span>Usual room</span>
              <select value={operatoryId} onChange={(e) => setOperatoryId(e.target.value)}>
                <option value="">Any room</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select></label>
          </div>
          <div className="grid2">
            <label className="field"><span>From</span>
              <input type="time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required /></label>
            <label className="field"><span>To</span>
              <input type="time" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required /></label>
          </div>
          {err && <p className="formerror">{err}</p>}
          <div className="inlineform__foot">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn btn--primary btn--sm" disabled={busy}>
              {busy ? 'Saving…' : 'Add'}
            </button>
          </div>
        </form>
      )}

      {!adding && err && <p className="formerror">{err}</p>}

      {entries.length === 0 ? (
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
          No hours set — this practitioner will show no free slots.
        </p>
      ) : (
        <div className="shifts">
          {WEEK_ORDER.map((d) => {
            const forDay = entries
              .filter((e) => e.weekday === d)
              .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
            if (!forDay.length) return null;
            return (
              <div key={d} className="shifts__day">
                <span className="shifts__label">{WEEKDAYS[d]!.slice(0, 3)}</span>
                {forDay.map((e) => (
                  <span key={e.id} className="shift">
                    {e.startsAt}–{e.endsAt}
                    {e.operatoryName && <span className="cell-sub"> · {e.operatoryName}</span>}
                    {canEdit && (
                      <button
                        type="button"
                        className="shift__x"
                        onClick={() => remove(e.id)}
                        aria-label={`Remove ${WEEKDAYS[d]} ${e.startsAt}–${e.endsAt}`}
                      >
                        <X size={11} />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
