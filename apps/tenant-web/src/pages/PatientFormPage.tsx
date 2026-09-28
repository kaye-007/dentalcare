import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { WHATSAPP_OPT_IN_SOURCES, WHATSAPP_OPT_IN_SOURCE_LABELS, type WhatsAppOptInSource } from '@dentalcare/shared';
import { api, humanError, type Patient, type PatientPayload } from '../lib/api';
import { Disclosure, PageHeader, PageLoading, useToast } from '../components/ui';

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
  whatsappPhone: '',
  whatsappOptIn: false,
  whatsappOptInSource: 'in_person',
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
  const toast = useToast();

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
          whatsappPhone: p.whatsappPhone ?? '',
          whatsappOptIn: p.whatsappOptIn,
          whatsappOptInSource: p.whatsappOptInSource ?? 'in_person',
        });
      })
      .finally(() => setLoading(false));
  }, [id]);

  const set = (k: Exclude<keyof PatientPayload, 'remindersOptOut' | 'whatsappOptIn'>, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // A new patient has not refused anything; the create endpoint does not
      // accept the field at all.
      const { remindersOptOut: _optOut, ...newPatient } = form;
      // On edit, an emptied ID is sent as null so it is cleared; `clean`
      // would otherwise drop the blank and leave the old value.
      const saved = editing
        ? await api.updatePatient(id!, {
            ...form,
            nationalId: (form.nationalId?.trim() || null) as unknown as string,
          })
        : await api.createPatient(newPatient);
      toast(editing ? 'Changes saved.' : `${saved.firstName} ${saved.lastName} added.`);
      navigate(`/patients/${saved.id}`);
    } catch (err) {
      // Everything typed stays in the form; only the reason is new.
      setError(humanError(err, 'The patient could not be saved. Nothing you typed was lost — try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageLoading label="Loading the patient" />;

  // Filled-in optional details open the section on edit, so nothing already
  // recorded is hidden from the person changing it.
  const extras = [
    form.gender,
    form.nationalId,
    form.address,
    form.city,
    form.postalCode,
    form.emergencyContactName,
    form.emergencyContactPhone,
  ].filter((v) => v && String(v).trim());
  const extrasHint =
    [form.city, form.emergencyContactName && `Emergency: ${form.emergencyContactName}`].filter(Boolean).join(' · ') ||
    'Address, ID, emergency contact';

  return (
    <div className="page page--narrow">
      <Link to={editing ? `/patients/${id}` : '/patients'} className="back">
        <ChevronLeft size={16} /> {editing ? 'Back to profile' : 'All patients'}
      </Link>
      <PageHeader
        title={editing ? 'Edit patient' : 'New patient'}
        meta={editing ? undefined : 'A name is enough to start. Add the rest now or later.'}
      />

      <form className="card form" onSubmit={submit}>
        <div className="grid2">
          <label className="field"><span>First name</span>
            <input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} required autoFocus={!editing} autoComplete="off" /></label>
          <label className="field"><span>Last name</span>
            <input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} required autoComplete="off" /></label>
        </div>
        <div className="grid2">
          <label className="field"><span>Phone</span>
            <input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="068 123 4567" /></label>
          <label className="field"><span>Date of birth</span>
            <input type="date" value={form.birthDate} onChange={(e) => set('birthDate', e.target.value)} /></label>
        </div>
        <label className="field"><span>Email</span>
          <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="name@example.al" /></label>

        <label className="checkrow">
          <input
            type="checkbox"
            checked={Boolean(form.whatsappOptIn)}
            onChange={(e) =>
              setForm((f) => ({ ...f, whatsappOptIn: e.target.checked, remindersOptOut: e.target.checked ? false : f.remindersOptOut }))
            }
          />
          <span>
            <strong>Agrees to appointment reminders on WhatsApp.</strong> Ask the patient — reminders go only
            to patients who said yes.
          </span>
        </label>
        {form.whatsappOptIn && (
          <div className="grid2">
            <label className="field"><span>How they agreed</span>
              <select
                value={form.whatsappOptInSource}
                onChange={(e) => setForm((f) => ({ ...f, whatsappOptInSource: e.target.value as WhatsAppOptInSource }))}
              >
                {WHATSAPP_OPT_IN_SOURCES.map((s) => (
                  <option key={s} value={s}>{WHATSAPP_OPT_IN_SOURCE_LABELS[s]}</option>
                ))}
              </select></label>
            <label className="field"><span>WhatsApp number</span>
              <input
                value={form.whatsappPhone}
                onChange={(e) => set('whatsappPhone', e.target.value)}
                placeholder={form.phone ? `Same as phone (${form.phone})` : '069 123 4567'}
              /></label>
          </div>
        )}

        <Disclosure summary="Additional information" hint={extrasHint} defaultOpen={editing && extras.length > 0}>
        <div className="grid2">
          <label className="field"><span>Gender</span>
            <select value={form.gender} onChange={(e) => set('gender', e.target.value)}>
              <option value="">—</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
            </select></label>
          <label className="field"><span>National ID (personal number)</span>
            <input
              value={form.nationalId}
              onChange={(e) => set('nationalId', e.target.value.toUpperCase())}
              placeholder="J12345678A"
              maxLength={24}
            /></label>
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
          <label className="checkrow">
            <input
              type="checkbox"
              checked={Boolean(form.remindersOptOut)}
              onChange={(e) =>
                setForm((f) => ({ ...f, remindersOptOut: e.target.checked, whatsappOptIn: e.target.checked ? false : f.whatsappOptIn }))
              }
            />
            <span>
              Asked to stop reminders
              {form.remindersOptOut && optOutSource === 'patient' ? ' — the patient opted out' : ''}
            </span>
          </label>
        )}

        {editing && (
          <label className="field"><span>Status</span>
            <select value={form.status} onChange={(e) => set('status', e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select></label>
        )}
        </Disclosure>

        {error && <p className="formerror" role="alert">{error}</p>}
        <div className="form__foot">
          <Link to={editing ? `/patients/${id}` : '/patients'} className="btn btn--ghost">Cancel</Link>
          <button className="btn btn--primary" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add patient'}
          </button>
        </div>
      </form>
    </div>
  );
}
