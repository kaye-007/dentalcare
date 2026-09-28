import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DoorOpen, Pencil, Plus, Trash2, X, CalendarClock } from 'lucide-react';
import {
  ApiError,
  appointmentsApi,
  availabilityApi,
  operatoriesApi,
  type AvailabilityEntry,
  type Operatory,
  type StaffMember,
  humanError,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader, EmptyState, LoadingRows, useConfirm } from '../components/ui';

/**
 * Clinic capacity, in the two things a clinic actually sets up once:
 *
 *  - the rooms (chairs) treatment happens in, and
 *  - for each practitioner, their home room and their weekly hours.
 *
 * The home room is what makes rooms worth having: a new booking with that
 * practitioner starts in it, and the calendar can show the day room by room.
 */

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
/** Monday-first for display; the stored value stays JS-native (0 = Sunday). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const PRESET_COLORS = ['#2f6f62', '#3a6ea5', '#8a5cf6', '#c2410c', '#0f766e', '#9a3412'];

export default function RoomsPage() {
  const confirm = useConfirm();
  const { can, user } = useAuth();
  const canManageRooms = can('operatories:manage');
  const canManageAnyone = can('availability:manage');

  const [rooms, setRooms] = useState<Operatory[] | null>(null);
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [availability, setAvailability] = useState<AvailabilityEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addingRoom, setAddingRoom] = useState(false);
  const [editingRoom, setEditingRoom] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, a, s] = await Promise.all([
        operatoriesApi.list(true),
        availabilityApi.list(),
        appointmentsApi.staff(),
      ]);
      setRooms(r);
      setAvailability(a);
      // Schedules are for the people who see patients.
      setStaff(s.filter((m) => m.status === 'active' && m.seesPatients));
      setError(null);
    } catch (e) {
      setError(humanError(e));
      setRooms((cur) => cur ?? []);
      setStaff((cur) => cur ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = (rooms ?? []).filter((r) => r.isActive);
  const archived = (rooms ?? []).filter((r) => !r.isActive);
  const homeOf = (roomId: string) =>
    (staff ?? []).filter((s) => s.homeOperatoryId === roomId).map((s) => s.fullName);

  async function removeRoom(room: Operatory) {
    const home = homeOf(room.id);
    const ok = await confirm({
      title: `Remove ${room.name}?`,
      body: `It stops being offered for new bookings; bookings that already have it keep it.${
        home.length ? ` It is the home room of ${home.join(', ')}.` : ''
      }`,
      confirmLabel: 'Remove room',
      danger: true,
    });
    if (!ok) return;
    setError(null);
    setNotice(null);
    try {
      const res = await operatoriesApi.remove(room.id);
      setNotice(
        res.deactivated
          ? `"${room.name}" has past appointments, so it was archived instead of deleted. Their history still shows the room.`
          : `"${room.name}" removed.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove the room.');
    }
  }

  async function restoreRoom(room: Operatory) {
    setError(null);
    setNotice(null);
    try {
      await operatoriesApi.update(room.id, { isActive: true });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not restore the room.');
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Rooms & working hours"
        meta="Set up once: the clinic's rooms, then each practitioner's room and hours"
      />

      {error && <p className="formerror">{error}</p>}
      {notice && (
        <p className="muted" style={{ fontSize: 13 }}>
          {notice}
        </p>
      )}

      <div className="grid">
        {/* ── rooms ── */}
        <div className="card span-12">
          <header className="card__head">
            <h3>
              <DoorOpen size={16} aria-hidden /> Rooms
            </h3>
            {canManageRooms && !addingRoom && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => setAddingRoom(true)}
              >
                <Plus size={14} /> Add room
              </button>
            )}
          </header>

          {addingRoom && (
            <RoomForm
              onDone={() => {
                setAddingRoom(false);
                void load();
              }}
              onCancel={() => setAddingRoom(false)}
            />
          )}

          {rooms === null ? (
            <LoadingRows rows={3} label="Loading rooms" />
          ) : active.length === 0 && !addingRoom ? (
            <EmptyState
              icon={<DoorOpen size={20} />}
              title="No rooms yet"
              body={
                canManageRooms
                  ? 'Add each chair or treatment room. Bookings then show which room is free, and two patients can never be booked into the same room at once.'
                  : 'No treatment rooms have been set up.'
              }
            />
          ) : (
            <ul className="recordlist">
              {active.map((r) =>
                editingRoom === r.id ? (
                  <li key={r.id} className="recordrow">
                    <RoomForm
                      room={r}
                      onDone={() => {
                        setEditingRoom(null);
                        void load();
                      }}
                      onCancel={() => setEditingRoom(null)}
                    />
                  </li>
                ) : (
                  <li key={r.id} className="recordrow">
                    <div className="recordrow__main">
                      <span
                        className="month__dot"
                        style={r.color ? { background: r.color } : undefined}
                      />
                      <span className="recordrow__title">{r.name}</span>
                      <span className="cell-sub">
                        {homeOf(r.id).length
                          ? `Home room of ${homeOf(r.id).join(', ')}`
                          : 'Nobody’s home room'}
                      </span>
                    </div>
                    {canManageRooms && (
                      <div className="recordrow__actions">
                        <button
                          className="iconbtn"
                          onClick={() => setEditingRoom(r.id)}
                          aria-label={`Edit ${r.name}`}
                        >
                          <Pencil size={15} />
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
                ),
              )}
            </ul>
          )}

          {archived.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? 'Hide' : 'Show'} archived rooms ({archived.length})
              </button>
              {showArchived && (
                <ul className="recordlist">
                  {archived.map((r) => (
                    <li key={r.id} className="recordrow recordrow--muted">
                      <div className="recordrow__main">
                        <span
                          className="month__dot"
                          style={r.color ? { background: r.color } : undefined}
                        />
                        <span className="recordrow__title">{r.name}</span>
                        <span className="cell-sub">
                          Archived — kept for past appointments
                        </span>
                      </div>
                      {canManageRooms && (
                        <div className="recordrow__actions">
                          <button
                            className="btn btn--ghost btn--sm"
                            onClick={() => restoreRoom(r)}
                          >
                            Restore
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* ── practitioners ── */}
        <div className="card span-12">
          <header className="card__head">
            <h3>
              <CalendarClock size={16} aria-hidden /> Practitioners
            </h3>
          </header>
          <p className="muted" style={{ fontSize: 12.5, margin: '0 0 14px' }}>
            Their room is where new bookings with them start — it can still be changed per
            booking. Hours are clinic-local and drive the free-slot finder. Everyone can
            edit their own; changing someone else&apos;s needs administrator access.
          </p>

          {staff === null ? (
            <LoadingRows rows={3} label="Loading" />
          ) : staff.length === 0 ? (
            <p className="muted">
              Nobody is marked as seeing patients yet. Turn it on for a person in Staff.
            </p>
          ) : (
            staff.map((s) => (
              <StaffSchedule
                key={s.id}
                staff={s}
                rooms={active}
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

/* ── add / edit a room ──────────────────────────────────── */
function RoomForm({
  room,
  onDone,
  onCancel,
}: {
  room?: Operatory;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(room?.name ?? '');
  const [color, setColor] = useState(room?.color ?? PRESET_COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      if (room) await operatoriesApi.update(room.id, { name: name.trim(), color });
      else await operatoriesApi.create({ name: name.trim(), color });
      onDone();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not save the room.');
      setBusy(false);
    }
  }

  return (
    <form className="inlineform" onSubmit={submit} style={{ flex: 1 }}>
      <label className="field">
        <span>Room name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Chair 1, Surgery, Hygiene…"
          autoFocus
          required
        />
      </label>
      <div className="field">
        <span>Colour on the calendar</span>
        <div className="sendrow">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch${color === c ? ' swatch--on' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`Colour ${c}`}
              aria-pressed={color === c}
            />
          ))}
        </div>
      </div>
      {err && <p className="formerror">{err}</p>}
      <div className="inlineform__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy}>
          {busy ? 'Saving…' : room ? 'Save' : 'Add room'}
        </button>
      </div>
    </form>
  );
}

/* ── one practitioner: room + week ──────────────────────── */
function StaffSchedule({
  staff,
  rooms,
  entries,
  canEdit,
  onChange,
}: {
  staff: StaffMember;
  rooms: Operatory[];
  entries: AvailabilityEntry[];
  canEdit: boolean;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  // Most clinics work the same hours across the week, so days are picked
  // together: Monday–Friday is one entry, not five.
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startsAt, setStartsAt] = useState('09:00');
  const [endsAt, setEndsAt] = useState('17:00');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleDay = (d: number) =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

  async function setHomeRoom(operatoryId: string) {
    setErr(null);
    try {
      await availabilityApi.setHomeRoom(staff.id, operatoryId || null);
      onChange();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not change the room.');
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!days.length) {
      setErr('Pick at least one day.');
      return;
    }
    setBusy(true);
    setErr(null);
    // One request per day; a clash on one day must not lose the others.
    const failed: string[] = [];
    for (const weekday of WEEK_ORDER.filter((d) => days.includes(d))) {
      try {
        await availabilityApi.create({ staffId: staff.id, weekday, startsAt, endsAt });
      } catch (e2) {
        failed.push(
          `${WEEKDAYS[weekday]}: ${e2 instanceof ApiError ? e2.message : 'not saved'}`,
        );
      }
    }
    setBusy(false);
    if (failed.length) setErr(failed.join(' · '));
    else setAdding(false);
    onChange();
  }

  async function remove(id: string) {
    setErr(null);
    try {
      await availabilityApi.remove(id);
      onChange();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not remove those hours.');
    }
  }

  return (
    <div className="schedule">
      <div className="schedule__head">
        <span className="recordrow__title">
          {staff.fullName}
          {staff.position && <span className="cell-sub"> · {staff.position}</span>}
        </span>
        <div className="schedule__tools">
          {rooms.length > 0 && (
            <label className="schedule__room">
              <DoorOpen size={13} aria-hidden />
              <select
                value={staff.homeOperatoryId ?? ''}
                onChange={(e) => void setHomeRoom(e.target.value)}
                disabled={!canEdit}
                aria-label={`${staff.fullName}'s room`}
              >
                <option value="">No fixed room</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canEdit && !adding && (
            <button className="btn btn--ghost btn--sm" onClick={() => setAdding(true)}>
              <Plus size={13} /> Add hours
            </button>
          )}
        </div>
      </div>

      {adding && (
        <form className="inlineform" onSubmit={add}>
          <div className="field">
            <span>Days</span>
            <div className="sendrow">
              {WEEK_ORDER.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`chip${days.includes(d) ? ' chip--on' : ''}`}
                  aria-pressed={days.includes(d)}
                  onClick={() => toggleDay(d)}
                >
                  {WEEKDAYS[d]!.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>
          <div className="grid2">
            <label className="field">
              <span>From</span>
              <input
                type="time"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>To</span>
              <input
                type="time"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                required
              />
            </label>
          </div>
          {err && <p className="formerror">{err}</p>}
          <div className="inlineform__foot">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setAdding(false);
                setErr(null);
              }}
            >
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
