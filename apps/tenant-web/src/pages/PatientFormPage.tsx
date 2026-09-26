import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { REMINDER_CHANNELS, REMINDER_CHANNEL_NAMES } from '@dentalcare/shared';
import { api, ApiError, type Patient, type PatientPayload } from '../lib/api';

const EMPTY: PatientPayload = {
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  gender: '',
  birthDate: '',
  address: '',
  city: '',
  postalCode: '',
  status: 'active',
  emergencyContactName: '',
  emergencyContactRelationship: '',
  emergencyContactPhone: '',
  remindersOptOut: false,
  nationalId: '',
  preferredChannel: '',
};

export default function PatientFormPage() {
  const { id } = useParams<{ id: string }>();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const [form, setForm] = useState<PatientPayload>(EMPTY);
  const [loading, setLoading] = useState(editing);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [optOutSource, setOptOutSource] = useState<Patient['remindersOptOutSource']>(null);

  useEffect(() => {
    if (!id) return;
    api
      .getPatient(id)
      .then((p) => {
        setOptOutSource(p.remindersOptOutSource);
        setForm({
          firstName: p.firstName,
          lastName: p.lastName,
          phone: p.phone ?? '',
          email: p.email ?? '',
          gender: p.gender ?? '',
          birthDate: p.birthDate ?? '',
          address: p.address ?? '',
          city: p.city ?? '',
          postalCode: p.postalCode ?? '',
          // The form edits active/inactive only. Archiving is a separate,
          // attributed action on the profile page.
          status: p.status === 'archived' ? 'inactive' : p.status,
          emergencyContactName: p.emergencyContact?.name ?? '',
          emergencyContactRelationship: p.emergencyContact?.relationship ?? '',
          emergencyContactPhone: p.emergencyContact?.phone ?? '',
          remindersOptOut: p.remindersOptOut,
          nationalId: p.nationalId ?? '',
          preferredChannel: p.preferredChannel ?? '',
        });
      })
      .finally(() => setLoading(false));
  }, [id]);

  const set = (k: Exclude<keyof PatientPayload, 'remindersOptOut'>, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // A new patient has not refused anything; the create endpoint does not
      // accept the field at all.
      const { remindersOptOut: _optOut, ...newPatient } = form;
      // On edit, an emptied ID or channel is sent as null so it is cleared;
      // `clean` would otherwise drop the blank and leave the old value.
      const saved = editing
        ? await api.updatePatient(id!, {
            ...form,
            nationalId: (form.nationalId?.trim() || null) as unknown as string,
            preferredChannel: (form.preferredChannel || null) as unknown as '',
          })
        : await api.createPatient(newPatient);
      navigate(`/patients/${saved.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save patient.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page page--narrow">
      <Link to={editing ? `/patients/${id}` : '/patients'} className="back">
        <ChevronLeft size={16} /> {editing ? 'Back to profile' : 'All patients'}
      </Link>
      <h1 className="section-title">{editing ? 'Edit patient' : 'New patient'}</h1>
      <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
        Only first and last name are required — everything else is optional.
      </p>

      <form className="card form" onSubmit={submit}>
        <div className="grid2">
          <label className="field"><span>First name</span>
            <input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} required /></label>
          <label className="field"><span>Last name</span>
            <input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} required /></label>
        </div>
        <div className="grid2">
          <label className="field"><span>Phone</span>
            <input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="068 123 4567" /></label>
          <label className="field"><span>Email</span>
            <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="name@example.al" /></label>
        </div>
        <div className="grid2">
          <label className="field"><span>Gender</span>
            <select value={form.gender} onChange={(e) => set('gender', e.target.value)}>
              <option value="">—</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
            </select></label>
          <label className="field"><span>Date of birth</span>
            <input type="date" value={form.birthDate} onChange={(e) => set('birthDate', e.target.value)} /></label>
        </div>
        <div className="grid2">
          <label className="field"><span>National ID (personal number)</span>
            <input
              value={form.nationalId}
              onChange={(e) => set('nationalId', e.target.value.toUpperCase())}
              placeholder="J12345678A"
              maxLength={24}
            /></label>
          <label className="field"><span>Reminders by</span>
            <select value={form.preferredChannel} onChange={(e) => set('preferredChannel', e.target.value)}>
              <option value="">The clinic’s usual channel</option>
              {REMINDER_CHANNELS.map((c) => (
                <option key={c} value={c}>{REMINDER_CHANNEL_NAMES[c]}</option>
              ))}
            </select></label>
        </div>
        <label className="field"><span>Address</span>
          <input value={form.address} onChange={(e) => set('address', e.target.value)} placeholder="Street and number" /></label>
        <div className="grid2">
          <label className="field"><span>City</span>
            <input value={form.city} onChange={(e) => set('city', e.target.value)} /></label>
          <label className="field"><span>Postal code</span>
            <input value={form.postalCode} onChange={(e) => set('postalCode', e.target.value)} /></label>
        </div>
        <fieldset className="fieldset">
          <legend>Emergency contact</legend>
          <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
            Who to call if something goes wrong during treatment. A name
            requires a phone number — a contact you cannot reach is not one.
          </p>
          <div className="grid2">
            <label className="field"><span>Name</span>
              <input
                value={form.emergencyContactName}
                onChange={(e) => set('emergencyContactName', e.target.value)}
                placeholder="Full name"
              /></label>
            <label className="field"><span>Relationship</span>
              <input
                value={form.emergencyContactRelationship}
                onChange={(e) => set('emergencyContactRelationship', e.target.value)}
                placeholder="Spouse, parent, friend…"
              /></label>
          </div>
          <label className="field"><span>Phone{form.emergencyContactName ? ' (required)' : ''}</span>
            <input
              value={form.emergencyContactPhone}
              onChange={(e) => set('emergencyContactPhone', e.target.value)}
              placeholder="+355 …"
              required={Boolean(form.emergencyContactName)}
            /></label>
        </fieldset>

        {editing && (
          <label className="hours-row__closed" style={{ width: 'auto' }}>
            <input
              type="checkbox"
              checked={Boolean(form.remindersOptOut)}
              onChange={(e) => setForm((f) => ({ ...f, remindersOptOut: e.target.checked }))}
            />
            <span>
              Does not want appointment reminders
              {form.remindersOptOut && optOutSource === 'patient'
                ? ' — replied STOP to a reminder'
                : form.remindersOptOut && optOutSource === 'provider'
                  ? ' — the SMS provider reports the number unsubscribed'
                  : ''}
            </span>
          </label>
        )}

        <label className="field"><span>Status</span>
          <select value={form.status} onChange={(e) => set('status', e.target.value)}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select></label>

        {error && <p className="formerror">{error}</p>}
        <div className="form__foot">
          <Link to={editing ? `/patients/${id}` : '/patients'} className="btn btn--ghost">Cancel</Link>
          <button className="btn btn--primary" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create patient'}
          </button>
        </div>
      </form>
    </div>
  );
}
