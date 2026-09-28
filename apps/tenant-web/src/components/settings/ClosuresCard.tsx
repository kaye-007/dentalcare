import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CalendarOff, Trash2 } from 'lucide-react';
import {
  appointmentsApi,
  closuresApi,
  ApiError,
  type Closure,
  type StaffMember,
  humanError,
} from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, LoadingRows } from '../ui';
import { dateLocale } from '../../lib/strings';
import { clinicToday } from '../../lib/clinic-time';

function fmt(d: string) {
  // A bare date, read as a calendar day — never shifted by the browser's zone.
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y!, m! - 1, day!).toLocaleDateString(dateLocale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** The clinic's today; a closure is a date on its calendar. */
const today = clinicToday;

/**
 * Holidays, closures and time off. The weekly pattern of who works when stays
 * in Rooms & hours; these are the exceptions, and the booking screen offers no
 * slots inside them.
 */
export default function ClosuresCard() {
  const { can } = useAuth();
  const canClinicWide = can('settings:manage');
  const canStaff = can('availability:manage');
  const [items, setItems] = useState<Closure[] | null>(null);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [form, setForm] = useState({
    staffId: '',
    startsOn: today(),
    endsOn: today(),
    reason: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    closuresApi
      .list(today())
      .then(setItems)
      .catch((e) => setError(humanError(e)));
  }, []);

  useEffect(() => {
    load();
    appointmentsApi
      .staff()
      .then((s) => setStaff(s.filter((m) => m.status === 'active')))
      .catch(() => setStaff([]));
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await closuresApi.create({
        staffId: form.staffId || undefined,
        startsOn: form.startsOn,
        endsOn: form.endsOn < form.startsOn ? form.startsOn : form.endsOn,
        reason: form.reason.trim(),
      });
      setForm((f) => ({ ...f, reason: '' }));
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add it.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: Closure) {
    setError(null);
    try {
      await closuresApi.remove(c.id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove it.');
    }
  }

  return (
    <section className="card">
      <div className="card__head">
        <div>
          <h2>Holidays &amp; time off</h2>
          <p className="card__sub">
            Days the clinic is closed or a clinician is away. Weekly shifts per clinician
            are in{' '}
            <Link to="/rooms" className="link">
              Rooms &amp; hours
            </Link>
            .
          </p>
        </div>
      </div>

      {(canClinicWide || canStaff) && (
        <form className="form" style={{ paddingTop: 16 }} onSubmit={add}>
          <div className="grid2">
            <label className="field">
              <span>Who</span>
              <select
                value={form.staffId}
                onChange={(e) => setForm((f) => ({ ...f, staffId: e.target.value }))}
              >
                {canClinicWide && <option value="">The whole clinic</option>}
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Reason</span>
              <input
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                placeholder="Independence Day, annual leave, training…"
                required
                minLength={2}
                maxLength={120}
              />
            </label>
          </div>
          <div className="grid2">
            <label className="field">
              <span>From</span>
              <input
                type="date"
                value={form.startsOn}
                onChange={(e) => setForm((f) => ({ ...f, startsOn: e.target.value }))}
                required
              />
            </label>
            <label className="field">
              <span>To (inclusive)</span>
              <input
                type="date"
                value={form.endsOn}
                min={form.startsOn}
                onChange={(e) => setForm((f) => ({ ...f, endsOn: e.target.value }))}
                required
              />
            </label>
          </div>
          {error && <p className="formerror">{error}</p>}
          <div className="form__foot">
            <button
              className="btn btn--primary btn--sm"
              disabled={busy || (!canClinicWide && !form.staffId)}
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      )}

      {items === null ? (
        <LoadingRows rows={3} label="Loading" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<CalendarOff size={20} />}
          title="Nothing coming up"
          body="No holidays or time off from today onwards."
        />
      ) : (
        <ul className="list">
          {items.map((c) => {
            const mayRemove = c.staffId ? canStaff : canClinicWide;
            return (
              <li className="row" key={c.id}>
                <span className="row__main">
                  <span className="row__title">
                    {c.staffName ?? 'Clinic closed'} · {c.reason}
                  </span>
                  <span className="row__sub">
                    {fmt(c.startsOn)}
                    {c.endsOn !== c.startsOn ? ` – ${fmt(c.endsOn)}` : ''}
                  </span>
                </span>
                {mayRemove && (
                  <button
                    className="iconbtn iconbtn--quiet"
                    aria-label={`Remove ${c.reason}`}
                    onClick={() => remove(c)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
