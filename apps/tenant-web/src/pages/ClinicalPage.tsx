import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarPlus,
  ChevronRight,
  ClipboardList,
  FlaskConical,
  Stethoscope,
} from 'lucide-react';
import {
  appointmentsApi,
  humanError,
  labApi,
  type Appointment,
  type ApptStatus,
  type LabOrder,
} from '../lib/api';
import { useBooking } from '../lib/booking';
import { nextLabStep, workLabel } from '../lib/lab';
import { useLabMove } from '../components/LabWork';
import { useAuth } from '../lib/auth';
import { isPractitioner } from '../lib/permissions';
import { fromWall, inClinicZone, wallNow } from '../lib/clinic-time';
import { dateLocale } from '../lib/strings';
import { useMinute } from '../lib/useMinute';
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeader,
  Segmented,
  StatusPill,
  useToast,
} from '../components/ui';

function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString(
    dateLocale(),
    inClinicZone({ hour: '2-digit', minute: '2-digit' }),
  );
}

/** The one forward step a clinician takes from each state, in their words. */
const ADVANCE: Partial<Record<ApptStatus, { to: ApptStatus; label: string }>> = {
  scheduled: { to: 'checked_in', label: 'Check in' },
  checked_in: { to: 'in_progress', label: 'Start treatment' },
  in_progress: { to: 'completed', label: 'Complete' },
};

type Scope = 'mine' | 'all';

/**
 * Clinical › Today — the clinician's day on one screen.
 *
 * Today's appointments → the patient → their chart, plans and notes → the
 * next appointment, without detours through the calendar. The patient at the
 * top is the one to see next; everyone else waits below in time order. Status
 * moves forward from here through the same state machine the calendar uses.
 */
export default function ClinicalPage() {
  const { user, can } = useAuth();
  const toast = useToast();
  const now = useMinute();
  const [appts, setAppts] = useState<Appointment[] | null>(null);
  const [transitions, setTransitions] = useState<Record<string, ApptStatus[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('mine');
  const canMove = can('appointments:write');
  const canBook = can('appointments:write');
  const openBooking = useBooking();
  // Lab work that is back for a patient seen today: the crown is here, the
  // dentist should know while the patient is in the chair.
  const canSeeLab = can('lab:read');
  const [lab, setLab] = useState<LabOrder[]>([]);
  const loadLab = useCallback(() => {
    if (!canSeeLab) return;
    labApi
      .list()
      .then(setLab)
      .catch(() => setLab([]));
  }, [canSeeLab]);
  useEffect(loadLab, [loadLab]);
  const moveLab = useLabMove(loadLab);

  const load = useCallback(() => {
    const from = wallNow();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    setError(null);
    appointmentsApi
      .list({ from: fromWall(from).toISOString(), to: fromWall(to).toISOString() })
      .then((list) =>
        setAppts(
          list
            .filter((a) => a.status !== 'cancelled')
            .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
        ),
      )
      .catch((e) => setError(humanError(e, 'Today’s appointments could not be loaded.')));
  }, []);

  useEffect(() => {
    load();
    appointmentsApi
      .statuses()
      .then((s) => setTransitions(s.transitions))
      .catch(() => setTransitions({}));
  }, [load]);

  const mineExists = useMemo(
    () =>
      Boolean(
        user && isPractitioner(user.role) && appts?.some((a) => a.staffId === user.id),
      ),
    [appts, user],
  );
  const effectiveScope: Scope = mineExists ? scope : 'all';
  const shown = useMemo(
    () => (appts ?? []).filter((a) => effectiveScope === 'all' || a.staffId === user?.id),
    [appts, effectiveScope, user?.id],
  );

  const inChair = shown.filter((a) => a.status === 'in_progress');
  const waiting = shown.filter(
    (a) =>
      (a.status === 'scheduled' || a.status === 'checked_in') &&
      Date.parse(a.endsAt) > now,
  );
  const done = shown.filter(
    (a) =>
      a.status === 'completed' ||
      a.status === 'no_show' ||
      ((a.status === 'scheduled' || a.status === 'checked_in') &&
        Date.parse(a.endsAt) <= now),
  );
  // Who to see next: whoever is in the chair, else the first still to come.
  const focus = inChair[0] ?? waiting[0] ?? null;
  const rest = [...inChair, ...waiting].filter((a) => a.id !== focus?.id);

  async function advance(a: Appointment) {
    const step = ADVANCE[a.status];
    if (!step) return;
    setBusyId(a.id);
    try {
      await appointmentsApi.transition(a.id, step.to);
      toast(`${a.patientName}: ${step.label.toLowerCase()} — done.`);
      load();
    } catch (e) {
      toast(humanError(e, 'The appointment could not be updated.'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  const allowed = (a: Appointment) => {
    const step = ADVANCE[a.status];
    return canMove && step && (transitions[a.status] ?? []).includes(step.to)
      ? step
      : null;
  };

  const today = new Date(now).toLocaleDateString(dateLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <div className="page">
      <PageHeader
        title="Today"
        meta={
          appts === null || shown.length === 0
            ? today
            : `${today} · ${waiting.length + inChair.length} to see · ${done.length} done`
        }
        actions={
          mineExists ? (
            <Segmented<Scope>
              label="Whose patients"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'mine', label: 'My patients' },
                { value: 'all', label: 'Everyone' },
              ]}
            />
          ) : undefined
        }
      />

      {error ? (
        <div className="card">
          <ErrorState body={error} onRetry={load} />
        </div>
      ) : appts === null ? (
        <div className="card">
          <LoadingRows rows={4} avatar label="Loading today’s patients" />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          framed
          icon={<Stethoscope size={22} />}
          title="No patients today"
          body="When appointments are booked for today they appear here, next patient first, with their chart one click away."
          action={
            canBook ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => openBooking({ onSaved: load })}
              >
                <CalendarPlus size={15} aria-hidden /> Book appointment
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="clin">
          {focus ? (
            <section className="clin__next card" aria-labelledby="clin-next">
              <p className="clin__eyebrow" id="clin-next">
                {focus.status === 'in_progress' ? 'In the chair' : 'Next patient'}
              </p>
              <div className="clin__nextmain">
                <div className="clin__who">
                  <Link to={`/patients/${focus.patientId}`} className="clin__name">
                    {focus.patientName}
                  </Link>
                  <p className="clin__what">
                    <span className="clin__time">
                      {fmtTime(focus.startsAt)}–{fmtTime(focus.endsAt)}
                    </span>
                    {' · '}
                    {focus.reason}
                    {focus.operatoryName ? ` · ${focus.operatoryName}` : ''}
                    {effectiveScope === 'all' && focus.staffName
                      ? ` · ${focus.staffName}`
                      : ''}
                  </p>
                </div>
                <StatusPill status={focus.status} />
              </div>
              <div className="clin__actions">
                {(() => {
                  const step = allowed(focus);
                  return step ? (
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busyId === focus.id}
                      onClick={() => void advance(focus)}
                    >
                      {busyId === focus.id ? 'Saving…' : step.label}
                    </button>
                  ) : null;
                })()}
                <Link
                  to={`/patients/${focus.patientId}?tab=chart`}
                  className="btn btn--ghost"
                >
                  Chart
                </Link>
                <Link
                  to={`/patients/${focus.patientId}?tab=plans`}
                  className="btn btn--ghost"
                >
                  Treatment plan
                </Link>
                <Link to={`/patients/${focus.patientId}#note`} className="btn btn--quiet">
                  <ClipboardList size={15} aria-hidden /> Note
                </Link>
                {canBook && (
                  <button
                    type="button"
                    className="btn btn--quiet"
                    onClick={() =>
                      openBooking({ patientId: focus.patientId, onSaved: load })
                    }
                  >
                    <CalendarPlus size={15} aria-hidden /> Next visit
                  </button>
                )}
              </div>
              {lab
                .filter((o) => o.patientId === focus.patientId && o.status === 'received')
                .map((o) => (
                  <p className="clin__lab" key={o.id}>
                    <FlaskConical size={15} aria-hidden />
                    <span>
                      {workLabel(o)} is back from the lab
                      {o.labName ? ` (${o.labName})` : ''}.
                    </span>
                    {can('lab:write') && nextLabStep(o.status) && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void moveLab(o, 'fitted')}
                      >
                        Fitted
                      </button>
                    )}
                  </p>
                ))}
            </section>
          ) : (
            <p className="clin__clear">Everyone for today has been seen.</p>
          )}

          {rest.length > 0 && (
            <section className="card" aria-labelledby="clin-later">
              <div className="card__head">
                <h2 id="clin-later">Later today</h2>
              </div>
              <ul className="list">
                {rest.map((a) => (
                  <ClinRow key={a.id} a={a} showStaff={effectiveScope === 'all'} />
                ))}
              </ul>
            </section>
          )}

          {done.length > 0 && (
            <section className="card clin__done" aria-labelledby="clin-done">
              <div className="card__head">
                <h2 id="clin-done">Seen today</h2>
              </div>
              <ul className="list">
                {done.map((a) => (
                  <ClinRow key={a.id} a={a} showStaff={effectiveScope === 'all'} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ClinRow({ a, showStaff }: { a: Appointment; showStaff: boolean }) {
  return (
    <li className="row clin__row">
      <span className="clin__rowtime">{fmtTime(a.startsAt)}</span>
      <span className="row__main">
        <Link to={`/patients/${a.patientId}`} className="row__title row__link">
          {a.patientName}
        </Link>
        <span className="row__sub">
          {a.reason}
          {showStaff && a.staffName ? ` · ${a.staffName}` : ''}
          {a.operatoryName ? ` · ${a.operatoryName}` : ''}
        </span>
      </span>
      {/* The list is in time order; only a state other than "booked" earns a pill. */}
      {a.status !== 'scheduled' ? <StatusPill status={a.status} /> : <span />}
      <Link
        to={`/patients/${a.patientId}?tab=chart`}
        className="iconbtn iconbtn--quiet"
        aria-label={`Open ${a.patientName}’s chart`}
        title="Open chart"
      >
        <ChevronRight size={16} aria-hidden />
      </Link>
    </li>
  );
}
