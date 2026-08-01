import { useEffect, useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, Pencil, Trash2 } from 'lucide-react';
import { api, appointmentsApi, type Patient, type Appointment } from '../lib/api';
import { Avatar, StatusPill, EmptyState } from '../components/ui';
import MedicalRecordCard from '../components/MedicalRecordCard';
import { CalendarDays } from 'lucide-react';

function fmtDate(s: string | null) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
function fmtDateTime(s: string) {
  return new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
        <Link to={`/patients/${p.id}/edit`} className="btn btn--ghost">
          <Pencil size={15} /> Edit
        </Link>
      </div>

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
        <MedicalRecordCard patientId={p.id} />

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
                    {new Date(a.startsAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                  </span>
                  <span className="row__main">
                    <span className="row__title">{a.reason}</span>
                    <span className="row__sub">
                      {new Date(a.startsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
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
