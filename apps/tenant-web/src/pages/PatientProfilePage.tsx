import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useParams, Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import PhotoCropModal from '../components/PhotoCropModal';
import CameraCaptureModal from '../components/CameraCaptureModal';
import { WHATSAPP_OPT_IN_SOURCE_LABELS } from '@dentalcare/shared';
import { inClinicZone } from '../lib/clinic-time';
import {
  AlertTriangle,
  Archive,
  Camera,
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Eye,
  FlaskConical,
  MessageCircle,
  Pencil,
  Phone,
  RotateCcw,
  Stethoscope,
  Wallet,
  X,
  ChevronDown,
} from 'lucide-react';
import {
  api,
  appointmentsApi,
  billingApi,
  documentsApi,
  financeApi,
  humanError,
  labApi,
  patientAccessApi,
  treatmentPlansApi,
  APPT_ACTIVE_STATUSES,
  type Patient,
  type Appointment,
  type InvoiceSummaryRow,
  type LabOrder,
  type LedgerEntry,
  type TreatmentPlan,
  type PatientAccessEntry,
  type PatientAccessResource,
} from '../lib/api';
import { WithdrawModal } from '../components/VoidModal';
import { ROLE_LABELS, type Role } from '../lib/permissions';
import {
  Avatar,
  Disclosure,
  EmptyState,
  LoadingRows,
  Modal,
  MoreMenu,
  PageLoading,
  StatusPill,
  useToast,
} from '../components/ui';
import DentalChartCard from '../components/DentalChartCard';
import TreatmentPlanCard from '../components/TreatmentPlanCard';
import PerioChartCard from '../components/PerioChartCard';
import PatientLedgerCard from '../components/PatientLedgerCard';
import MedicalHistoryCard from '../components/MedicalHistoryCard';
import DocumentsCard from '../components/DocumentsCard';
import { useAuth } from '../lib/auth';
import { formatMoney, plural, toDate } from '../lib/format';
import { dateLocale } from '../lib/strings';
import { useBooking } from '../lib/booking';
import { labWhen, workLabel } from '../lib/lab';
import LabOrderSheet from '../components/LabOrderSheet';
import { useMessaging } from '../lib/messaging';
import { LabCancel, LabWorkRow, useLabMove } from '../components/LabWork';

function fmtDate(s: string | null) {
  if (!s) return '—';
  // A date alone ("1998-01-25") is a calendar date; a timestamp is an
  // instant, read on the clinic's clock like every appointment time.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };
  return toDate(s).toLocaleDateString(dateLocale(), dateOnly ? opts : inClinicZone(opts));
}
function fmtDateTime(s: string) {
  return new Date(s).toLocaleString(dateLocale(), inClinicZone({
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }));
}
/** "Tue 24 Oct, 14:00" — for a visit that is coming up. */
function fmtWhen(s: string) {
  return new Date(s).toLocaleString(dateLocale(), inClinicZone({
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }));
}
function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString(dateLocale(), inClinicZone({
    hour: '2-digit',
    minute: '2-digit',
  }));
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
  // What the patient owes, and the invoices it is on. Loaded only for staff
  // who may see money; the ledger read is recorded as a billing view.
  const [balance, setBalance] = useState<number | null>(null);
  // The same ledger read, kept: its charges and payments are part of the
  // record's story, so the timeline shows them beside the visits.
  const [money, setMoney] = useState<LedgerEntry[]>([]);
  const [openInvoices, setOpenInvoices] = useState<InvoiceSummaryRow[]>([]);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const openBooking = useBooking();
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
  const canTakePayment = can('payments:write') && !readOnly;
  const canSeeLab = can('lab:read');
  const canWriteLab = can('lab:write') && !readOnly;
  const canMessage = can('reminders:send') && !readOnly;
  const canSeePlans = can('clinical:read');
  // The patient's lab work and treatment plans: what is at the lab, and what
  // was agreed and not yet booked, are part of "what needs attention".
  const [lab, setLab] = useState<LabOrder[]>([]);
  const [plans, setPlans] = useState<TreatmentPlan[]>([]);
  const [labSheet, setLabSheet] = useState<{ order?: LabOrder } | null>(null);
  const [labCancelling, setLabCancelling] = useState<LabOrder | null>(null);
  const openMessage = useMessaging();

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

  const loadLab = useCallback(() => {
    if (!id || !canSeeLab) return;
    labApi
      .list({ patientId: id })
      .then(setLab)
      .catch(() => setLab([]));
  }, [id, canSeeLab]);
  useEffect(loadLab, [loadLab]);
  const moveLab = useLabMove(loadLab);
  useEffect(() => {
    if (!id || !canSeePlans) return;
    let live = true;
    treatmentPlansApi
      .listForPatient(id)
      .then((l) => live && setPlans(l))
      .catch(() => live && setPlans([]));
    return () => {
      live = false;
    };
  }, [id, canSeePlans]);

  // The header's balance. Separate from load(): the record must not wait on
  // the account, and a billing outage must not hide the record.
  useEffect(() => {
    if (!id || !canSeeBilling) return;
    let live = true;
    setBalance(null);
    setMoney([]);
    billingApi
      .ledger(id)
      .then((l) => {
        if (!live) return;
        setBalance(l.balance);
        setMoney(l.entries);
      })
      .catch(() => live && setBalance(null));
    return () => {
      live = false;
    };
  }, [id, canSeeBilling]);

  useEffect(() => {
    if (!p || !canSeeBilling || !balance || balance <= 0) {
      setOpenInvoices([]);
      return;
    }
    let live = true;
    // By id, not by name: a namesake's invoices never come back, and an
    // older open invoice cannot fall past the list's newest-200 cap.
    financeApi
      .listInvoices({ patientId: p.id, status: 'open' })
      .then((rows) => live && setOpenInvoices(rows))
      .catch(() => live && setOpenInvoices([]));
    return () => {
      live = false;
    };
  }, [p, canSeeBilling, balance]);

  // "#note" (from Clinical › Today) lands in the note box, ready to type.
  useEffect(() => {
    if (location.hash !== '#note' || !p) return;
    const timer = window.setTimeout(() => {
      noteRef.current?.focus();
      noteRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [location.hash, p]);

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
      toast('Note added.');
      await load();
    } catch (err) {
      toast(humanError(err, 'The note could not be saved. It is still in the box.'), 'error');
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
      setActionError(humanError(e, 'The record could not be archived.'));
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
      toast('Record restored.');
      await load();
    } catch (e) {
      setActionError(humanError(e, 'The record could not be restored.'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageLoading label="Loading the patient record" />;
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
  // Booking opens over the record: the patient is known, and this is where
  // the desk wants to be afterwards.
  const book = () => openBooking({ patientId: p.id, onSaved: () => void load() });
  // One open invoice: pay it directly. Several: the account shows them all.
  const payHref =
    openInvoices.length === 1 ? `/invoices/${openInvoices[0]!.id}?pay=1` : `?tab=billing`;
  const writeNote = () => {
    if (tab !== 'overview') selectTab('overview');
    navigate({ search: location.search.replace(/([?&])tab=[^&]*&?/, '$1').replace(/[?&]$/, ''), hash: 'note' }, { replace: true });
    window.setTimeout(() => noteRef.current?.focus(), 80);
  };
  const detailsHint = [p.phone, p.email, p.city].filter(Boolean).join(' · ') || 'Nothing recorded yet';

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
              {archived && <StatusPill status={p.status} />}
            </div>
            {meta.length > 0 && <p className="profile__meta">{meta.join(' · ')}</p>}
            {p.status !== 'active' && !archived && <StatusPill status={p.status} />}
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
                <span className="profile__noflag">No allergies recorded</span>
              )}
            </div>
          </div>
          <div className="profile__actions">
            {!archived && (
              <Link to={`/patients/${p.id}/edit`} className="btn btn--quiet">
                <Pencil size={15} aria-hidden /> Edit
              </Link>
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
            <MoreMenu
              label="More actions for this patient"
              items={[
                ...(canMessage && !archived && p.phone
                  ? [
                      {
                        label: 'Send a message',
                        icon: <MessageCircle size={15} aria-hidden />,
                        onSelect: () => openMessage({ patientId: p.id, patientName: fullName }),
                      },
                    ]
                  : []),
                ...(canWriteLab && !archived
                  ? [
                      {
                        label: 'Order lab work',
                        icon: <FlaskConical size={15} aria-hidden />,
                        onSelect: () => setLabSheet({}),
                      },
                    ]
                  : []),
                ...(canEditPatient && !archived
                  ? [
                      {
                        label: 'Archive record…',
                        icon: <Archive size={15} aria-hidden />,
                        onSelect: () => setArchiving(true),
                        danger: true,
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        </div>

        {/* The four things done most often with a patient, in one row. */}
        {!archived && (
          <div className="profile__do">
            {canBook && (
              <button type="button" className="btn btn--primary" onClick={book}>
                <CalendarPlus size={16} aria-hidden /> Appointment
              </button>
            )}
            {canWriteHistory && (
              <button type="button" className="btn btn--ghost" onClick={writeNote}>
                <ClipboardList size={16} aria-hidden /> Note
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={() => selectTab('plans')}>
              <Stethoscope size={16} aria-hidden /> Treatment
            </button>
            {canSeeBilling && canTakePayment && (
              <Link to={payHref} className="btn btn--ghost">
                <Wallet size={16} aria-hidden /> Payment
              </Link>
            )}
          </div>
        )}

        <dl className="profile__facts">
          <div>
            <dt>Phone</dt>
            <dd className={p.phone ? undefined : 'muted'}>
              {p.phone ? (
                <>
                  <a href={`tel:${p.phone.replace(/\s+/g, '')}`}>{p.phone}</a>
                  {canMessage && !archived && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="linkbtn profile__move"
                        onClick={() => openMessage({ patientId: p.id, patientName: fullName })}
                        aria-label={`Send ${p.firstName} a message`}
                      >
                        Message
                      </button>
                    </>
                  )}
                </>
              ) : (
                'Not recorded'
              )}
            </dd>
          </div>
          <div>
            <dt>Next appointment</dt>
            <dd className={nextVisit ? undefined : 'muted'}>
              {history === null ? '…' : nextVisit ? fmtWhen(nextVisit.startsAt) : 'None booked'}
              {nextVisit && canBook && !archived && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="linkbtn profile__move"
                    onClick={() => openBooking({ move: nextVisit, onSaved: () => void load() })}
                    aria-label={`Move the appointment on ${fmtWhen(nextVisit.startsAt)}`}
                  >
                    Move
                  </button>
                </>
              )}
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
          {canSeeBilling && (
            <div>
              <dt>Balance</dt>
              <dd className={balance ? (balance > 0 ? 'profile__owes' : undefined) : 'muted'}>
                {balance === null
                  ? '…'
                  : balance > 0
                    ? `Owes ${formatMoney(balance)}`
                    : balance < 0
                      ? `${formatMoney(-balance)} in credit`
                      : 'Settled'}
              </dd>
            </div>
          )}
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

      <div role="tabpanel" id={`ppanel-${tab}`} aria-labelledby={`ptab-${tab}`} key={tab}>
        {tab === 'overview' && (
          <div className="grid">
            <div className="stack span-8">
              {!archived && (
                <PatientAttention
                  items={attentionItems({
                    lab,
                    plans,
                    upcomingCount: history === null ? null : upcoming.length,
                    lastVisitAt: lastVisit?.startsAt ?? null,
                    hasPhone: Boolean(p.phone),
                    canBook,
                    canEdit: canEditPatient,
                    book: (treatmentId) =>
                      openBooking({ patientId: p.id, treatmentId, onSaved: () => void load() }),
                    edit: () => navigate(`/patients/${p.id}/edit`),
                    showLab: () =>
                      document
                        .getElementById('pp-lab')
                        ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
                  })}
                />
              )}
              {/* What is coming, then one timeline of what happened — visits
                  and notes together, newest first — so the record reads as a
                  course of care rather than a set of tables. */}
              <section className="card" aria-labelledby="pp-story">
                <div className="card__head">
                  <h2 id="pp-story">History</h2>
                  <button
                    type="button"
                    className="link"
                    onClick={() => selectTab('appointments')}
                  >
                    All visits <ChevronRight size={15} aria-hidden />
                  </button>
                </div>
                {canWriteHistory && !archived && (
                  <form className="noteform" onSubmit={addNote} id="note">
                    <label className="sr-only" htmlFor="pp-note">
                      New clinical note
                    </label>
                    <textarea
                      id="pp-note"
                      ref={noteRef}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Write a clinical or admin note…"
                      rows={note ? 4 : 2}
                    />
                    {note.trim() && (
                      <button className="btn btn--primary btn--sm" disabled={busy}>
                        {busy ? 'Saving…' : 'Add note'}
                      </button>
                    )}
                  </form>
                )}
                {history === null ? (
                  <LoadingRows rows={3} label="Loading the history" />
                ) : (
                  <Story
                    upcoming={upcoming}
                    past={past}
                    notes={p.notes}
                    money={money}
                    canWithdraw={canWriteHistory}
                    onWithdraw={setWithdrawingNote}
                    onBook={!archived && canBook ? book : null}
                  />
                )}
                {withdrawingNote && (
                  <WithdrawModal
                    what="this note"
                    onClose={() => setWithdrawingNote(null)}
                    onConfirm={(reason) => withdrawNote(withdrawingNote, reason)}
                  />
                )}
              </section>
            </div>

            <div className="stack span-4">
              <MedicalHistoryCard patientId={p.id} />

              {lab.length > 0 && (
                <section className="card" aria-labelledby="pp-lab" id="pp-lab-card">
                  <div className="card__head">
                    <h2 id="pp-lab">Lab work</h2>
                    {canWriteLab && !archived && (
                      <button type="button" className="link" onClick={() => setLabSheet({})}>
                        Order
                      </button>
                    )}
                  </div>
                  <ul className="labrows labrows--card">
                    {lab
                      .filter((o) => o.status !== 'cancelled')
                      .slice(0, 5)
                      .map((o) => (
                        <LabWorkRow
                          key={o.id}
                          order={o}
                          canWrite={canWriteLab}
                          showPatient={false}
                          onMove={(x, to) => void moveLab(x, to)}
                          onEdit={(x) => setLabSheet({ order: x })}
                          onCancel={setLabCancelling}
                        />
                      ))}
                  </ul>
                </section>
              )}

              <section className="card profile__details" aria-label="Contact and details">
                <div className="pad">
                <Disclosure summary="Contact & details" hint={detailsHint}>
                <dl className="info info--stack">
                  <div>
                    <dt>Email</dt>
                    <dd>
                      {p.email ? (
                        <a href={`mailto:${p.email}`}>{p.email}</a>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
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
                  <div>
                    <dt>WhatsApp reminders</dt>
                    <dd>
                      {p.remindersOptOut
                        ? 'Asked to stop'
                        : p.whatsappOptIn
                          ? `Agreed ${p.whatsappOptedInAt ? fmtDate(p.whatsappOptedInAt.slice(0, 10)) : ''}${
                              p.whatsappOptInSource ? ` · ${WHATSAPP_OPT_IN_SOURCE_LABELS[p.whatsappOptInSource].toLowerCase()}` : ''
                            }`
                          : 'No consent recorded'}
                      {p.whatsappOptIn && p.whatsappPhone && p.whatsappPhone !== p.phone ? ` · ${p.whatsappPhone}` : ''}
                    </dd>
                  </div>
                </dl>

                <h3 className="info__heading">
                  <Phone size={14} aria-hidden /> Emergency contact
                </h3>
                {p.emergencyContact ? (
                  <dl className="info info--stack">
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
                </Disclosure>
                </div>
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
              <LoadingRows rows={3} label="Loading" />
            ) : history.length === 0 ? (
              <EmptyState
                icon={<CalendarDays size={20} />}
                title="No appointments yet"
                body="Their first visit will show here."
                action={
                  !archived && canBook ? (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={book}>
                      <CalendarPlus size={15} aria-hidden /> Book appointment
                    </button>
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

      {labSheet && (
        <LabOrderSheet
          order={labSheet.order}
          patient={{ id: p.id, name: fullName }}
          onClose={() => setLabSheet(null)}
          onSaved={() => {
            setLabSheet(null);
            loadLab();
          }}
        />
      )}
      {labCancelling && (
        <LabCancel
          order={labCancelling}
          onClose={() => setLabCancelling(null)}
          onCancel={(reason) => {
            const o = labCancelling;
            setLabCancelling(null);
            void moveLab(o, 'cancelled', reason);
          }}
        />
      )}
    </div>
  );
}

/* ── what needs attention ───────────────────────────────── */

interface AttentionItem {
  key: string;
  icon: 'lab' | 'plan' | 'recall' | 'phone';
  text: string;
  action?: { label: string; run: () => void };
}

/**
 * What on this record needs someone, worked out from what is already known:
 * lab work that is late or back to fit, treatment agreed and not booked, a
 * check-up that is due, a patient nobody can reach. Each line carries the
 * one thing to do about it. Nothing here is stored; it is read off the record.
 */
function attentionItems(k: {
  lab: LabOrder[];
  plans: TreatmentPlan[];
  /** null while the appointments are loading. */
  upcomingCount: number | null;
  lastVisitAt: string | null;
  hasPhone: boolean;
  canBook: boolean;
  canEdit: boolean;
  book: (treatmentId?: string) => void;
  edit: () => void;
  showLab: () => void;
}): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const o of k.lab) {
    if (o.overdue) {
      out.push({
        key: `lab-${o.id}`,
        icon: 'lab',
        text: `${workLabel(o)} is ${labWhen(o).text} at ${o.labName ?? 'the lab'}`,
        action: { label: 'Lab work', run: k.showLab },
      });
    } else if (o.status === 'received') {
      out.push({
        key: `lab-${o.id}`,
        icon: 'lab',
        text: `${workLabel(o)} is back from the lab, ready to fit`,
        action: k.canBook ? { label: 'Book fitting', run: () => k.book() } : undefined,
      });
    }
  }
  if (k.upcomingCount === null) return out;
  // Agreed and not booked. A plan line is not marked "scheduled" when a visit
  // is booked from the calendar, so only a patient with nothing booked at all
  // is said to be waiting — no false alarms for someone already coming in.
  const todo = k.plans
    .filter((pl) => pl.status === 'accepted' || pl.status === 'in_progress')
    .flatMap((pl) => pl.items.filter((i) => i.status === 'planned'));
  if (todo.length > 0 && k.upcomingCount === 0) {
    const named = todo
      .slice(0, 2)
      .map((i) => (i.tooth ? `${i.description} ${i.tooth}` : i.description))
      .join(', ');
    out.push({
      key: 'plan',
      icon: 'plan',
      text: `${plural(todo.length, 'accepted treatment')} with nothing booked: ${named}${
        todo.length > 2 ? '…' : ''
      }`,
      action: k.canBook
        ? { label: 'Book', run: () => k.book(todo[0]!.treatmentId ?? undefined) }
        : undefined,
    });
  } else if (k.upcomingCount === 0 && k.lastVisitAt) {
    const months = Math.floor((Date.now() - Date.parse(k.lastVisitAt)) / (30.44 * 86_400_000));
    if (months >= 6) {
      out.push({
        key: 'recall',
        icon: 'recall',
        text: `Due for a check-up · last visit ${months} months ago, nothing booked`,
        action: k.canBook ? { label: 'Book', run: () => k.book() } : undefined,
      });
    }
  }
  if (!k.hasPhone) {
    out.push({
      key: 'phone',
      icon: 'phone',
      text: 'No phone number: reminders cannot reach this patient',
      action: k.canEdit ? { label: 'Add', run: k.edit } : undefined,
    });
  }
  return out;
}

const ATTENTION_ICON = {
  lab: FlaskConical,
  plan: Stethoscope,
  recall: RotateCcw,
  phone: Phone,
} as const;

function PatientAttention({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="card attention attention--record" aria-label="Needs attention">
      <ul>
        {items.map((it) => {
          const Icon = ATTENTION_ICON[it.icon];
          return (
            <li key={it.key}>
              <div className={`attention__row attention__row--${it.icon}`}>
                <Icon size={16} aria-hidden />
                <span className="attention__text">{it.text}</span>
                {it.action && (
                  <button type="button" className="linkbtn attention__go" onClick={it.action.run}>
                    {it.action.label} <ChevronRight size={15} aria-hidden />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
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
/**
 * Who opened this record. An administrator's compliance view, not what a
 * clinician opens the record for, so it stays folded — and is only fetched
 * once someone unfolds it.
 */
function RecordAccessCard({ patientId }: { patientId: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PatientAccessEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpen(false);
  }, [patientId]);

  useEffect(() => {
    if (!open) return;
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
  }, [patientId, open]);

  return (
    <section className="card accesscard" aria-labelledby="pp-access">
      <h2 id="pp-access" className="accesscard__head">
        <button
          type="button"
          className="accesscard__toggle"
          aria-expanded={open}
          aria-controls="pp-access-list"
          onClick={() => setOpen((v) => !v)}
        >
          <Eye size={15} aria-hidden /> Record access
          <ChevronDown size={16} className="accesscard__chev" aria-hidden />
        </button>
      </h2>
      {!open ? null : error ? (
        <p className="pad muted">{error}</p>
      ) : rows === null ? (
        <LoadingRows rows={3} label="Loading" />
      ) : rows.length === 0 ? (
        <p className="pad muted">Nobody has opened this record yet.</p>
      ) : (
        <ul className="list" id="pp-access-list">
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

/* ── the overview's story: next, then what happened ─────── */
type StoryItem =
  | { kind: 'visit'; at: number; a: Appointment }
  | { kind: 'note'; at: number; n: Patient['notes'][number] }
  | { kind: 'money'; at: number; e: LedgerEntry };

function Story({
  upcoming,
  past,
  notes,
  money,
  canWithdraw,
  onWithdraw,
  onBook,
}: {
  upcoming: Appointment[];
  past: Appointment[];
  notes: Patient['notes'];
  /** Ledger entries; empty for anyone who may not see money. */
  money: LedgerEntry[];
  canWithdraw: boolean;
  onWithdraw: (id: string) => void;
  onBook: (() => void) | null;
}) {
  const items: StoryItem[] = [
    ...past.map((a) => ({ kind: 'visit' as const, at: Date.parse(a.startsAt), a })),
    ...notes.map((n) => ({ kind: 'note' as const, at: Date.parse(n.created_at), n })),
    ...money.map((e) => ({ kind: 'money' as const, at: Date.parse(e.createdAt), e })),
  ].sort((x, y) => y.at - x.at);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, 8);

  return (
    <>
      <h3 className="timeline__heading">Coming up</h3>
      {upcoming.length === 0 ? (
        <p className="story__none">
          Nothing booked.{' '}
          {onBook && (
            <button type="button" className="linkbtn" onClick={onBook}>
              Book the next visit
            </button>
          )}
        </p>
      ) : (
        <Timeline items={upcoming.slice(0, 3)} />
      )}

      <h3 className="timeline__heading">Before</h3>
      {items.length === 0 ? (
        <p className="story__none">No visits or notes yet.</p>
      ) : (
        <ol className="timeline">
          {shown.map((it) =>
            it.kind === 'visit' ? (
              <TimelineVisit key={`v${it.a.id}`} a={it.a} />
            ) : it.kind === 'money' ? (
              <TimelineMoney key={`m${it.e.id}`} e={it.e} />
            ) : (
              <li key={`n${it.n.id}`} className="timeline__item timeline__item--note">
                <span className="timeline__dot" aria-hidden />
                <TimelineDate iso={it.n.created_at} />
                <div className="timeline__body">
                  <p className="timeline__notebody">{it.n.body}</p>
                  <p className="timeline__meta">
                    Note · {it.n.author_name ?? 'Staff'} · {fmtTime(it.n.created_at)}
                  </p>
                </div>
                {canWithdraw ? (
                  <button
                    type="button"
                    className="note__del"
                    onClick={() => onWithdraw(it.n.id)}
                    title="Withdraw as entered in error"
                    aria-label="Withdraw note as entered in error"
                  >
                    <X size={14} />
                  </button>
                ) : (
                  <span />
                )}
              </li>
            ),
          )}
        </ol>
      )}
      {items.length > 8 && (
        <div className="story__more">
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => setShowAll((s) => !s)}>
            {showAll ? 'Show less' : `Show ${items.length - 8} more`}
          </button>
        </div>
      )}
    </>
  );
}

function TimelineDate({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <span className="timeline__date">
      <span className="timeline__day">
        {d.toLocaleDateString(dateLocale(), inClinicZone({ day: '2-digit' }))}
      </span>
      <span className="timeline__month">
        {d.toLocaleDateString(dateLocale(), inClinicZone({ month: 'short', year: 'numeric' }))}
      </span>
    </span>
  );
}

function TimelineVisit({ a }: { a: Appointment }) {
  return (
    <li className={`timeline__item timeline__item--${a.status}`}>
      <span className="timeline__dot" aria-hidden />
      <TimelineDate iso={a.startsAt} />
      <div className="timeline__body">
        <p className="timeline__title">{a.reason}</p>
        <p className="timeline__meta">
          {fmtTime(a.startsAt)}–{fmtTime(a.endsAt)}
          {a.staffName ? ` · ${a.staffName}` : ''}
          {a.operatoryName ? ` · ${a.operatoryName}` : ''}
        </p>
        {a.cancelReason && <p className="timeline__note">Cancellation reason: {a.cancelReason}</p>}
      </div>
      <StatusPill status={a.status} />
    </li>
  );
}

/** A charge or a payment, in the patient's words: what was billed, what was paid. */
function TimelineMoney({ e }: { e: LedgerEntry }) {
  const paid = e.amount < 0;
  const title =
    e.entryType === 'charge'
      ? `Invoice ${e.invoiceNumber ?? ''} · ${formatMoney(e.amount)}`
      : e.entryType === 'payment'
        ? `Payment · ${formatMoney(-e.amount)}`
        : `${e.description} · ${formatMoney(Math.abs(e.amount))}`;
  const method = /\(([^)]+)\)/.exec(e.description)?.[1];
  return (
    <li className={`timeline__item timeline__item--money${paid ? ' timeline__item--paid' : ''}`}>
      <span className="timeline__dot" aria-hidden />
      <TimelineDate iso={e.createdAt} />
      <div className="timeline__body">
        <p className="timeline__title">
          {e.invoiceId ? (
            <Link to={`/invoices/${e.invoiceId}`} className="timeline__link">
              {title}
            </Link>
          ) : (
            title
          )}
        </p>
        <p className="timeline__meta">
          {[
            e.entryType === 'payment' && method ? method[0]!.toUpperCase() + method.slice(1) : null,
            e.balanceAfter > 0 ? `Balance ${formatMoney(e.balanceAfter)}` : 'Account settled',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <span />
    </li>
  );
}

/* ── clinical timeline ──────────────────────────────────── */
function Timeline({ items }: { items: Appointment[] }) {
  return (
    <ol className="timeline">
      {items.map((a) => (
        <TimelineVisit key={a.id} a={a} />
      ))}
    </ol>
  );
}
