import { useEffect, useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, Pencil, Trash2, Archive, RotateCcw, Phone } from 'lucide-react';
import { api, appointmentsApi, type Patient, type Appointment } from '../lib/api';
import { Avatar, StatusPill, EmptyState } from '../components/ui';
import DentalChartCard from '../components/DentalChartCard';
import TreatmentPlanCard from '../components/TreatmentPlanCard';
import PerioChartCard from '../components/PerioChartCard';
import PatientLedgerCard from '../components/PatientLedgerCard';
import MedicalHistoryCard from '../components/MedicalHistoryCard';
import DocumentsCard from '../components/DocumentsCard';
import { useAuth } from '../lib/auth';
import { CalendarDays } from 'lucide-react';
import { dateLocale } from '../lib/i18n';

function fmtDate(s: string | null) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' });
}
function fmtDateTime(s: string) {
  return new Date(s).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function genderLabel(g: string | null) {
  return g ? g[0]!.toUpperCase() + g.slice(1) : '—';
}

export default function PatientProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [p, setP] = useState<Patient | null>(null);
  const [history, setHistory] = useState<Appointment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const { can } = useAuth();
  const canEditPatient = can('patients:write');

  async function load() {
    if (!id) return;
    setP(await api.getPatient(id));
    appointmentsApi.list({ patientId: id }).then((a) => setHistory(a.reverse())).catch(() => setHistory([]));
  }
  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [id]);

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

  async function removeNote(noteId: string) {
    await api.deleteNote(noteId);
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

  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!p) return <div className="page"><p className="muted">Patient not found.</p></div>;

  return (
    <div className="page">
      <Link to="/patients" className="back"><ChevronLeft size={16} /> All patients</Link>

      <div className="profile__head">
        <Avatar name={`${p.firstName} ${p.lastName}`} size={56} />
        <div className="profile__id">
          <h2 className="section-title">{p.firstName} {p.lastName}</h2>
          <StatusPill status={p.status} />
        </div>
        <div className="profile__actions">
          {p.status !== 'archived' && (
            <Link to={`/patients/${p.id}/edit`} className="btn btn--ghost">
              <Pencil size={15} /> Edit
            </Link>
          )}
          {canEditPatient && p.status !== 'archived' && (
            <button className="btn btn--ghost" onClick={() => setArchiving(true)} disabled={busy}>
              <Archive size={15} /> Archive
            </button>
          )}
          {canEditPatient && p.status === 'archived' && (
            <button className="btn btn--primary" onClick={restore} disabled={busy}>
              <RotateCcw size={15} /> Restore
            </button>
          )}
        </div>
      </div>

      {p.status === 'archived' && (
        <div className="alertbanner alertbanner--muted" role="status">
          <Archive size={18} aria-hidden />
          <div>
            <strong>
              This record is archived
              {p.archivedByName ? ` by ${p.archivedByName}` : ''}
              {p.archivedAt ? ` on ${fmtDate(p.archivedAt)}` : ''}.
            </strong>
            <p>
              {p.archiveReason
                ? `Reason: ${p.archiveReason}`
                : 'No reason was recorded.'}{' '}
              It is retained in full and can be restored at any time.
            </p>
          </div>
        </div>
      )}

      {actionError && <p className="formerror">{actionError}</p>}

      {archiving && (
        <div className="modal__overlay" role="dialog" aria-modal="true" aria-label="Archive patient">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header className="modal__head"><h2>Archive {p.firstName} {p.lastName}?</h2></header>
            <div className="modal__body">
              <p className="muted">
                The record is kept in full — appointments, invoices and clinical
                history are untouched. It is hidden from the patient list and can
                be restored at any time. Dental records are never deleted outright.
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
            </div>
            <div className="modal__foot">
              <button className="btn btn--ghost" onClick={() => setArchiving(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn--primary" onClick={archive} disabled={busy}>
                {busy ? 'Archiving…' : 'Archive patient'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid">
        <div className="card span-8">
          <div className="card__head"><h2>Patient information</h2></div>
          <div className="info">
            <div><span>Phone</span><b>{p.phone ?? '—'}</b></div>
            <div><span>Email</span><b>{p.email ?? '—'}</b></div>
            <div><span>Gender</span><b>{genderLabel(p.gender)}</b></div>
            <div><span>Date of birth</span><b>{fmtDate(p.birthDate)}</b></div>
            <div><span>Address</span><b>{p.address ?? '—'}</b></div>
            <div><span>City</span><b>{p.city ?? '—'}</b></div>
            <div><span>Postal code</span><b>{p.postalCode ?? '—'}</b></div>
            <div><span>Registered</span><b>{fmtDate(p.createdAt)}</b></div>
          </div>

          <div className="card__subhead">
            <h3><Phone size={15} aria-hidden /> Emergency contact</h3>
          </div>
          {p.emergencyContact ? (
            <div className="info">
              <div><span>Name</span><b>{p.emergencyContact.name}</b></div>
              <div>
                <span>Relationship</span>
                <b>{p.emergencyContact.relationship ?? '—'}</b>
              </div>
              <div><span>Phone</span><b>{p.emergencyContact.phone ?? '—'}</b></div>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              None recorded.{' '}
              {canEditPatient && (
                <Link to={`/patients/${p.id}/edit`}>Add one</Link>
              )}
            </p>
          )}
        </div>

        <div className="card span-4">
          <div className="card__head"><h2>Notes</h2></div>
          <form className="noteform" onSubmit={addNote}>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a clinical or admin note…"
              rows={3}
            />
            <button className="btn btn--primary btn--sm" disabled={busy || !note.trim()}>
              {busy ? 'Saving…' : 'Add note'}
            </button>
          </form>
          <ul className="notes">
            {p.notes.length === 0 && <li className="muted notes__empty">No notes yet.</li>}
            {p.notes.map((n) => (
              <li key={n.id} className="note">
                <p className="note__body">{n.body}</p>
                <div className="note__foot">
                  <span>{n.author_name ?? 'Staff'} · {fmtDateTime(n.created_at)}</span>
                  <button className="note__del" onClick={() => removeNote(n.id)} title="Delete note">
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="span-12">
          <MedicalHistoryCard patientId={p.id} />
        </div>

        <DentalChartCard patientId={p.id} />

        <PerioChartCard patientId={p.id} />

        <TreatmentPlanCard patientId={p.id} />

        <PatientLedgerCard patientId={p.id} />

        <div className="span-12">
          <DocumentsCard patientId={p.id} />
        </div>

        <div className="card span-12">
          <div className="card__head"><h2>Appointments</h2></div>
          {history === null ? (
            <div className="pad muted">Loading…</div>
          ) : history.length === 0 ? (
            <EmptyState
              icon={<CalendarDays size={20} />}
              title="No appointments yet"
              body="Book one from the Reservations calendar."
            />
          ) : (
            <ul className="list">
              {history.map((a) => (
                <li className="row" key={a.id}>
                  <span className="row__time">
                    {new Date(a.startsAt).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short' })}
                  </span>
                  <span className="row__main">
                    <span className="row__title">{a.reason}</span>
                    <span className="row__sub">
                      {new Date(a.startsAt).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })}
                      {a.staffName ? ` · ${a.staffName}` : ''}
                    </span>
                  </span>
                  <StatusPill status={a.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
