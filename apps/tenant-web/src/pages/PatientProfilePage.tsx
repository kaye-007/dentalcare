import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import PhotoCropModal from '../components/PhotoCropModal';
import CameraCaptureModal from '../components/CameraCaptureModal';
import {
  AlertTriangle,
  Archive,
  Camera,
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Eye,
  MessageCircle,
  Pencil,
  Phone,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  api,
  appointmentsApi,
  documentsApi,
  patientAccessApi,
  APPT_ACTIVE_STATUSES,
  type Patient,
  type Appointment,
  type PatientAccessEntry,
  type PatientAccessResource,
} from '../lib/api';
import { WithdrawModal } from '../components/VoidModal';
import { ROLE_LABELS, type Role } from '../lib/permissions';
import { Avatar, StatusPill, EmptyState, Modal } from '../components/ui';
import DentalChartCard from '../components/DentalChartCard';
import TreatmentPlanCard from '../components/TreatmentPlanCard';
import PerioChartCard from '../components/PerioChartCard';
import PatientLedgerCard from '../components/PatientLedgerCard';
import MedicalHistoryCard from '../components/MedicalHistoryCard';
import DocumentsCard from '../components/DocumentsCard';
import { useAuth } from '../lib/auth';
import { toDate } from '../lib/format';
import { dateLocale } from '../lib/strings';

function fmtDate(s: string | null) {
  if (!s) return '—';
  return toDate(s).toLocaleDateString(dateLocale(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
function fmtDateTime(s: string) {
  return new Date(s).toLocaleString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
/** "Tue 24 Oct, 14:00" — for a visit that is coming up. */
function fmtWhen(s: string) {
  return new Date(s).toLocaleString(dateLocale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString(dateLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
}
function genderLabel(g: string | null) {
  return g ? g[0]!.toUpperCase() + g.slice(1) : '—';
}
/**
 * Whole years from a YYYY-MM-DD birth date. Parsed by parts rather than with
 * `new Date(s)`, which reads a bare date as UTC midnight and puts everyone
 * west of Greenwich a day younger on their birthday.
 */
function ageFrom(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const [y, m, d] = birthDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age >= 0 ? age : null;
}

type TabKey = 'overview' | 'chart' | 'plans' | 'appointments' | 'billing' | 'documents';
interface TabDef {
  key: TabKey;
  label: string;
  count?: number;
}

export default function PatientProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [p, setP] = useState<Patient | null>(null);
  const [history, setHistory] = useState<Appointment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [withdrawingNote, setWithdrawingNote] = useState<string | null>(null);
  const { can, readOnly } = useAuth();
  const canEditPatient = can('patients:write');
  const canWriteHistory = can('history:write') && !readOnly;
  // Who opened this record is an administrator's question: the same gate as
  // the activity trail, for the same reason.
  const canSeeAccess = can('audit:read');
  const canBook = can('appointments:write') && !readOnly;
  // The same gate PatientLedgerCard applies to itself; a tab that opened onto
  // nothing would be worse than no tab.
  const canSeeBilling = can('invoices:read');

  // Which patient the URL names right now, and which request is the newest.
  // A response, including the appointment history that arrives after it, is
  // written only if it is still the newest one for that patient. Otherwise a
  // slow request for the previous patient could show their record and history
  // under this patient's URL. Notes are added to the patient in the URL, not
  // to the record shown.
  //
  // The route id is checked BEFORE the request is numbered. A note saved on
  // the previous patient still calls load() from its own closure when it
  // finishes. Numbered, it would supersede the current patient's load and then
  // be discarded itself, so neither response would ever be written.
  const routeId = useRef(id);
  const latest = useRef(0);
  useEffect(() => {
    routeId.current = id;
  }, [id]);

  // useCallback so the effect below can depend on load and re-run exactly
  // when the id changes. The notes, archive and restore handlers call it
  // after their mutations too.
  const load = useCallback(async () => {
    if (!id || id !== routeId.current) return;
    const ticket = ++latest.current;
    const current = () => ticket === latest.current;
    const patient = await api.getPatient(id);
    if (current()) setP(patient);
    appointmentsApi
      .list({ patientId: id })
      .then((a) => {
        if (current()) setHistory(a.reverse());
      })
      .catch(() => {
        if (current()) setHistory([]);
      });
  }, [id]);
  useEffect(() => {
    // Only the effect for the current id may end the loading state. A load
    // that was superseded and finishes late must not drop the "Loading…"
    // screen while the current patient's request is still in flight.
    let active = true;
    setLoading(true);
    load().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [load]);

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const all = history ?? [];
    const time = (a: Appointment) => new Date(a.startsAt).getTime();
    const next = all
      .filter(
        (a) =>
          APPT_ACTIVE_STATUSES.includes(a.status) && new Date(a.endsAt).getTime() >= now,
      )
      .sort((a, b) => time(a) - time(b));
    const ids = new Set(next.map((a) => a.id));
    const before = all.filter((a) => !ids.has(a.id)).sort((a, b) => time(b) - time(a));
    return { upcoming: next, past: before };
  }, [history]);

  const tabs = useMemo<TabDef[]>(
    () => [
      { key: 'overview', label: 'Overview' },
      { key: 'chart', label: 'Dental chart' },
      { key: 'plans', label: 'Treatment plans' },
      { key: 'appointments', label: 'Appointments', count: history?.length },
      ...(canSeeBilling ? [{ key: 'billing' as const, label: 'Billing' }] : []),
      { key: 'documents', label: 'Documents' },
    ],
    [history, canSeeBilling],
  );
  const requested = searchParams.get('tab');
  const tab: TabKey = tabs.find((x) => x.key === requested)?.key ?? 'overview';

  // The tab lives in the URL so a link to "this patient's chart" works and a
  // reload lands where you were. Replace, not push: flicking between tabs
  // should not fill Back with them.
  const selectTab = useCallback(
    (key: TabKey) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (key === 'overview') next.delete('tab');
          else next.set('tab', key);
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );

  // Arrow keys move between tabs, per the ARIA tabs pattern.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((x) => x.key === tab);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    const key = tabs[n]!.key;
    selectTab(key);
    document.getElementById(`ptab-${key}`)?.focus();
  };

  async function addNote(e: FormEvent) {
    e.preventDefault();
    if (!id || !note.trim()) return;
    setBusy(true);
    try {
      await api.addNote(id, note.trim());
      setNote('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function withdrawNote(noteId: string, reason: string) {
    await api.withdrawNote(noteId, reason);
    setWithdrawingNote(null);
    await load();
  }

  async function archive() {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.archivePatient(id, archiveReason.trim() || undefined);
      setArchiving(false);
      setArchiveReason('');
      if (res.upcomingAppointmentsAffected > 0) {
        setActionError(
          `Archived. Note: this patient still has ${res.upcomingAppointmentsAffected} upcoming appointment(s) — cancel them from Reservations if they are no longer expected.`,
        );
      }
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.restorePatient(id);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <div className="page">
        <p className="pad muted">Loading patient…</p>
      </div>
    );
  if (!p)
    return (
      <div className="page">
        <Link to="/patients" className="back">
          <ChevronLeft size={16} aria-hidden /> All patients
        </Link>
        <EmptyState
          framed
          icon={<CalendarDays size={22} />}
          title="Patient not found"
          body="The record may have been removed, or the link is incomplete."
        />
      </div>
    );

  const fullName = `${p.firstName} ${p.lastName}`;
  const archived = p.status === 'archived';
  const age = ageFrom(p.birthDate);
  const allergies = p.allergySummary;
  const nextVisit = upcoming[0];
  const lastVisit = past.find((a) => a.status === 'completed');
  const meta = [
    p.gender ? genderLabel(p.gender) : null,
    age !== null ? `${age} years` : null,
    p.city,
  ].filter(Boolean);
  const bookHref = `/reservations?new=1&patient=${encodeURIComponent(p.id)}`;

  return (
    <div className="page">
      <Link to="/patients" className="back">
        <ChevronLeft size={16} aria-hidden /> All patients
      </Link>

      <section className="card profile" aria-labelledby="patient-name">
        <div className="profile__main">
          <ProfilePhoto
            patientId={p.id}
            name={fullName}
            url={p.photoUrl ?? null}
            canChange={canEditPatient && can('documents:write') && !readOnly && !archived}
            onChanged={load}
          />
          <div className="profile__id">
            <div className="profile__titleline">
              <h1 className="section-title" id="patient-name">
                {fullName}
              </h1>
              <StatusPill status={p.status} />
            </div>
            {meta.length > 0 && <p className="profile__meta">{meta.join(' · ')}</p>}
            {/* Allergies sit in the header, not only in the Overview tab: a
                clinician who opens straight onto the chart must still see a
                severe allergy before touching anything. */}
            <div className="profile__flags">
              {allergies && allergies.count > 0 ? (
                <span className={`pill ${allergies.hasSevere ? 'pill--danger' : 'pill--warn'}`}>
                  <AlertTriangle size={13} aria-hidden />
                  {allergies.hasSevere ? 'Severe allergy' : 'Allergies'}:{' '}
                  {allergies.substances.join(', ')}
                </span>
              ) : (
                <span className="pill pill--neutral">No allergies recorded</span>
              )}
            </div>
          </div>
          <div className="profile__actions">
            {!archived && canBook && (
              <Link to={bookHref} className="btn btn--primary">
                <CalendarPlus size={16} aria-hidden /> Book appointment
              </Link>
            )}
            {can('reminders:read') && (
              <Link to={`/messages?patient=${encodeURIComponent(p.id)}`} className="btn btn--ghost">
                <MessageCircle size={15} aria-hidden /> Messages
              </Link>
            )}
            {!archived && (
              <Link to={`/patients/${p.id}/edit`} className="btn btn--ghost">
                <Pencil size={15} aria-hidden /> Edit
              </Link>
            )}
            {canEditPatient && !archived && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setArchiving(true)}
                disabled={busy}
              >
                <Archive size={15} aria-hidden /> Archive
              </button>
            )}
            {canEditPatient && archived && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={restore}
                disabled={busy}
              >
                <RotateCcw size={15} aria-hidden /> Restore
              </button>
            )}
          </div>
        </div>

        <dl className="profile__facts">
          <div>
            <dt>Phone</dt>
            <dd className={p.phone ? undefined : 'muted'}>
              {p.phone ? (
                <a href={`tel:${p.phone.replace(/\s+/g, '')}`}>{p.phone}</a>
              ) : (
                'Not recorded'
              )}
            </dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd className={p.email ? undefined : 'muted'}>
              {p.email ? (
                <a href={`mailto:${p.email}`} title={p.email}>
                  {p.email}
                </a>
              ) : (
                'Not recorded'
              )}
            </dd>
          </div>
          <div>
            <dt>Next appointment</dt>
            <dd className={nextVisit ? undefined : 'muted'}>
              {history === null ? '…' : nextVisit ? fmtWhen(nextVisit.startsAt) : 'None booked'}
            </dd>
          </div>
          <div>
            <dt>Last visit</dt>
            <dd className={lastVisit ? undefined : 'muted'}>
              {history === null
                ? '…'
                : lastVisit
                  ? fmtDate(lastVisit.startsAt)
                  : 'No completed visits'}
            </dd>
          </div>
        </dl>

        <div
          className="subnav"
          role="tablist"
          aria-label="Patient record"
          onKeyDown={onTabKey}
        >
          {tabs.map((item) => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                id={`ptab-${item.key}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`ppanel-${item.key}`}
                tabIndex={active ? 0 : -1}
                className={`subnav__tab${active ? ' subnav__tab--active' : ''}`}
                onClick={() => selectTab(item.key)}
              >
                {item.label}
                {item.count !== undefined && (
                  <span className="subnav__count">{item.count}</span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {archived && (
        <div className="alertbanner alertbanner--muted" role="status">
          <Archive size={18} aria-hidden />
          <div>
            <strong>
              This record is archived
              {p.archivedByName ? ` by ${p.archivedByName}` : ''}
              {p.archivedAt ? ` on ${fmtDate(p.archivedAt)}` : ''}.
            </strong>
            <p>
              {p.archiveReason ? `Reason: ${p.archiveReason}` : 'No reason was recorded.'}{' '}
              It is retained in full and can be restored at any time.
            </p>
          </div>
        </div>
      )}

      {actionError && (
        <p className="formerror" role="alert" style={{ marginBottom: 16 }}>
          {actionError}
        </p>
      )}

      {archiving && (
        <Modal
          title={`Archive ${fullName}?`}
          onClose={() => {
            if (!busy) setArchiving(false);
          }}
        >
          <div className="modal__body">
            <p className="muted" style={{ margin: 0 }}>
              The record is kept in full — appointments, invoices and clinical history are
              untouched. It is hidden from the patient list and can be restored at any time.
              Dental records are never deleted outright.
            </p>
            <label className="field">
              <span>Reason (optional, recorded for audit)</span>
              <input
                value={archiveReason}
                onChange={(e) => setArchiveReason(e.target.value)}
                placeholder="Moved away, transferred to another practice…"
                autoFocus
              />
            </label>
            <div className="modal__foot">
              <div className="modal__foot-right">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setArchiving(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={archive}
                  disabled={busy}
                >
                  {busy ? 'Archiving…' : 'Archive patient'}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      <div role="tabpanel" id={`ppanel-${tab}`} aria-labelledby={`ptab-${tab}`}>
        {tab === 'overview' && (
          <div className="grid">
            <div className="stack span-8">
              <section className="card" aria-labelledby="pp-details">
                <div className="card__head">
                  <h2 id="pp-details">Patient details</h2>
                  {!archived && (
                    <Link to={`/patients/${p.id}/edit`} className="link">
                      <Pencil size={14} aria-hidden /> Edit details
                    </Link>
                  )}
                </div>
                <dl className="info">
                  <div>
                    <dt>Date of birth</dt>
                    <dd>
                      {fmtDate(p.birthDate)}
                      {age !== null ? ` (${age})` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Gender</dt>
                    <dd>{genderLabel(p.gender)}</dd>
                  </div>
                  <div>
                    <dt>Registered</dt>
                    <dd>{fmtDate(p.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Address</dt>
                    <dd>{p.address ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>City</dt>
                    <dd>{p.city ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Postal code</dt>
                    <dd>{p.postalCode ?? '—'}</dd>
                  </div>
                </dl>

                <h3 className="info__heading">
                  <Phone size={14} aria-hidden /> Emergency contact
                </h3>
                {p.emergencyContact ? (
                  <dl className="info">
                    <div>
                      <dt>Name</dt>
                      <dd>{p.emergencyContact.name}</dd>
                    </div>
                    <div>
                      <dt>Relationship</dt>
                      <dd>{p.emergencyContact.relationship ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Phone</dt>
                      <dd>{p.emergencyContact.phone ?? '—'}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="info__empty">
                    None recorded.{' '}
                    {canEditPatient && (
                      <Link to={`/patients/${p.id}/edit`} className="link">
                        Add one
                      </Link>
                    )}
                  </p>
                )}
              </section>

              <MedicalHistoryCard patientId={p.id} />
            </div>

            <div className="stack span-4">
              <section className="card" aria-labelledby="pp-upcoming">
                <div className="card__head">
                  <h2 id="pp-upcoming">Upcoming</h2>
                  <button
                    type="button"
                    className="link"
                    onClick={() => selectTab('appointments')}
                  >
                    All visits <ChevronRight size={15} aria-hidden />
                  </button>
                </div>
                {history === null ? (
                  <p className="pad muted">Loading…</p>
                ) : upcoming.length === 0 ? (
                  <p className="pad muted">Nothing booked.</p>
                ) : (
                  <ul className="list">
                    {upcoming.slice(0, 3).map((a) => (
                      <li className="row" key={a.id}>
                        <span className="row__main">
                          <span className="row__title">{a.reason}</span>
                          <span className="row__sub">
                            {fmtWhen(a.startsAt)}
                            {a.staffName ? ` · ${a.staffName}` : ''}
                          </span>
                        </span>
                        <StatusPill status={a.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="card" aria-labelledby="pp-notes">
                <div className="card__head">
                  <h2 id="pp-notes">Notes</h2>
                </div>
                {canWriteHistory && (
                <form className="noteform" onSubmit={addNote}>
                  <label className="sr-only" htmlFor="pp-note">
                    New note
                  </label>
                  <textarea
                    id="pp-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Add a clinical or admin note…"
                    rows={3}
                  />
                  <button className="btn btn--ghost btn--sm" disabled={busy || !note.trim()}>
                    {busy ? 'Saving…' : 'Add note'}
                  </button>
                </form>
                )}
                <ul className="notes">
                  {p.notes.length === 0 && <li className="muted notes__empty">No notes yet.</li>}
                  {p.notes.map((n) => (
                    <li key={n.id} className="note">
                      <p className="note__body">{n.body}</p>
                      <div className="note__foot">
                        <span>
                          {n.author_name ?? 'Staff'} · {fmtDateTime(n.created_at)}
                        </span>
                        {canWriteHistory && (
                          <button
                            type="button"
                            className="note__del"
                            onClick={() => setWithdrawingNote(n.id)}
                            title="Withdraw as entered in error"
                            aria-label="Withdraw note as entered in error"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {withdrawingNote && (
                  <WithdrawModal
                    what="this note"
                    onClose={() => setWithdrawingNote(null)}
                    onConfirm={(reason) => withdrawNote(withdrawingNote, reason)}
                  />
                )}
              </section>

              {canSeeAccess && <RecordAccessCard patientId={p.id} />}
            </div>
          </div>
        )}

        {tab === 'chart' && (
          <div className="stack">
            <DentalChartCard patientId={p.id} />
            <PerioChartCard patientId={p.id} />
          </div>
        )}

        {tab === 'plans' && <TreatmentPlanCard patientId={p.id} />}

        {tab === 'appointments' && (
          <section className="card" aria-labelledby="pp-visits">
            <div className="card__head">
              <div>
                <h2 id="pp-visits">Appointments</h2>
                <p className="card__sub">
                  {history === null
                    ? 'Loading…'
                    : `${upcoming.length} upcoming · ${past.length} past`}
                </p>
              </div>
            </div>
            {history === null ? (
              <p className="pad muted">Loading…</p>
            ) : history.length === 0 ? (
              <EmptyState
                icon={<CalendarDays size={20} />}
                title="No appointments yet"
                body="Book one from the Reservations calendar."
                action={
                  !archived && canBook ? (
                    <Link to={bookHref} className="btn btn--ghost btn--sm">
                      <CalendarPlus size={15} aria-hidden /> Book appointment
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <>
                {upcoming.length > 0 && (
                  <>
                    <h3 className="timeline__heading">Upcoming</h3>
                    <Timeline items={upcoming} />
                  </>
                )}
                {past.length > 0 && (
                  <>
                    <h3 className="timeline__heading">Past</h3>
                    <Timeline items={past} />
                  </>
                )}
              </>
            )}
          </section>
        )}

        {tab === 'billing' && <PatientLedgerCard patientId={p.id} />}

        {tab === 'documents' && <DocumentsCard patientId={p.id} />}
      </div>
    </div>
  );
}

/* ── profile photo ──────────────────────────────────────── */

/**
 * The picture, or the initials when there is none. Clicking offers the camera
 * — the front-desk webcam or a tablet's — or a file, and then the cropper; the
 * cropped square is re-encoded in the browser, which also drops the camera's
 * location data before anything is uploaded.
 */
function ProfilePhoto({
  patientId,
  name,
  url,
  canChange,
  onChanged,
}: {
  patientId: string;
  name: string;
  url: string | null;
  canChange: boolean;
  onChanged: () => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [camera, setCamera] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const picture = url ? <img src={url} alt={name} width={64} height={64} /> : <Avatar name={name} size={64} />;

  if (!canChange) return picture;

  async function remove() {
    setRemoving(true);
    setError(null);
    try {
      await documentsApi.clearProfilePhoto(patientId);
      setChoosing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The photo could not be removed.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) {
            setChoosing(false);
            setFile(f);
          }
        }}
      />
      <button
        type="button"
        className="avatar-photo"
        onClick={() => setChoosing(true)}
        title={url ? 'Change photo' : 'Add a photo'}
        aria-label={url ? `Change ${name}'s photo` : `Add a photo of ${name}`}
      >
        {picture}
        <span className="avatar-photo__edit" aria-hidden>
          <Camera size={13} />
        </span>
      </button>
      {choosing && (
        <Modal title="Profile photo" subtitle="JPEG, PNG or WEBP. You can crop it before saving." onClose={() => setChoosing(false)}>
          <div className="modal__body">
            <div className="photo-menu">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setChoosing(false);
                  setCamera(true);
                }}
              >
                <Camera size={15} aria-hidden /> Take a photo
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => input.current?.click()}>
                Choose a file
              </button>
              {url && (
                <button type="button" className="btn btn--ghost" onClick={remove} disabled={removing}>
                  {removing ? 'Removing…' : 'Remove photo'}
                </button>
              )}
            </div>
            {error && <p className="formerror">{error}</p>}
          </div>
        </Modal>
      )}
      {camera && (
        <CameraCaptureModal
          title="Profile photo"
          subtitle="Centre the face in the circle."
          frame="square"
          facing="user"
          onClose={() => setCamera(false)}
          onCapture={(f) => {
            setCamera(false);
            setFile(f);
          }}
        />
      )}
      {file && (
        <PhotoCropModal
          file={file}
          onClose={() => setFile(null)}
          onSave={async (image) => {
            await documentsApi.setProfilePhoto(patientId, image);
            setFile(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

/* ── record access ──────────────────────────────────────── */

const ACCESS_LABEL: Record<PatientAccessResource, string> = {
  record: 'Opened the record',
  chart: 'Viewed the dental chart',
  procedures: 'Viewed procedures',
  perio: 'Viewed perio exams',
  history: 'Viewed medical history',
  documents: 'Listed documents',
  document_file: 'Opened a document',
  treatment_plans: 'Viewed treatment plans',
  billing: 'Viewed billing',
  messages: 'Viewed messages',
};

/**
 * Who has opened this record, newest first. Repeat views by the same person
 * of the same section within five minutes are recorded once, so this reads as
 * a list of visits rather than of clicks.
 */
function RecordAccessCard({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<PatientAccessEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    patientAccessApi
      .list(patientId, 50)
      .then((r) => {
        if (live) setRows(r);
      })
      .catch(() => {
        if (live) setError('Could not load who opened this record.');
      });
    return () => {
      live = false;
    };
  }, [patientId]);

  return (
    <section className="card" aria-labelledby="pp-access">
      <div className="card__head">
        <h2 id="pp-access">
          <Eye size={15} aria-hidden /> Record access
        </h2>
      </div>
      {error ? (
        <p className="pad muted">{error}</p>
      ) : rows === null ? (
        <p className="pad muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="pad muted">Nobody has opened this record yet.</p>
      ) : (
        <ul className="list">
          {rows.map((r) => (
            <li className="row" key={r.id}>
              <span className="row__main">
                <span className="row__title">{r.actor.currentName ?? r.actor.label}</span>
                <span className="row__sub">
                  {ACCESS_LABEL[r.resource] ?? r.resource}
                  {' · '}
                  {ROLE_LABELS[r.actor.role as Role] ?? r.actor.role}
                  {' · '}
                  {fmtDateTime(r.accessedAt)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── clinical timeline ──────────────────────────────────── */
function Timeline({ items }: { items: Appointment[] }) {
  return (
    <ol className="timeline">
      {items.map((a) => {
        const d = new Date(a.startsAt);
        return (
          <li key={a.id} className={`timeline__item timeline__item--${a.status}`}>
            <span className="timeline__dot" aria-hidden />
            <span className="timeline__date">
              <span className="timeline__day">
                {d.toLocaleDateString(dateLocale(), { day: '2-digit' })}
              </span>
              <span className="timeline__month">
                {d.toLocaleDateString(dateLocale(), { month: 'short', year: 'numeric' })}
              </span>
            </span>
            <div className="timeline__body">
              <p className="timeline__title">{a.reason}</p>
              <p className="timeline__meta">
                {fmtTime(a.startsAt)}–{fmtTime(a.endsAt)}
                {a.staffName ? ` · ${a.staffName}` : ''}
                {a.operatoryName ? ` · ${a.operatoryName}` : ''}
              </p>
              {a.cancelReason && (
                <p className="timeline__note">Cancellation reason: {a.cancelReason}</p>
              )}
            </div>
            <StatusPill status={a.status} />
          </li>
        );
      })}
    </ol>
  );
}
