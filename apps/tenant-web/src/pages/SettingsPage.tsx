import { useEffect, useState, type FormEvent } from 'react';
import { Lock, Check } from 'lucide-react';
import { settingsApi, ApiError, type ClinicSettings, type WorkingDay } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader, EmptyState } from '../components/ui';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DURATIONS = [15, 30, 45, 60, 90, 120];

export default function SettingsPage() {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const [settings, setSettings] = useState<ClinicSettings | null>(null);

  useEffect(() => {
    if (isOwner) settingsApi.get().then(setSettings);
  }, [isOwner]);

  if (!isOwner) {
    return (
      <div className="page">
        <EmptyState framed icon={<Lock size={22} />} title="Owner access only"
          body="Clinic settings are restricted to the clinic owner." />
      </div>
    );
  }

  if (!settings) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page page--narrow">
      <PageHeader title="Settings" meta="Clinic profile, working hours, and preferences" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ProfileCard initial={settings} />
        <HoursCard initial={settings.workingHours} />
        <RemindersCard initial={settings} />
        <PreferencesCard initial={settings.defaultAppointmentDuration} payrollInitial={settings.payrollLoggingEnabled} />
      </div>
    </div>
  );
}

function SaveButton({ busy, saved }: { busy: boolean; saved: boolean }) {
  return (
    <button className="btn btn--primary btn--sm" disabled={busy}>
      {busy ? 'Saving…' : saved ? (<><Check size={14} /> Saved</>) : 'Save changes'}
    </button>
  );
}

function ProfileCard({ initial }: { initial: ClinicSettings }) {
  const [form, setForm] = useState({
    clinicName: initial.clinicName,
    address: initial.address,
    city: initial.city,
    phone: initial.phone,
    email: initial.email,
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: string) => { setSaved(false); setForm((f) => ({ ...f, [k]: v })); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await settingsApi.update(form);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally { setBusy(false); }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head"><h2>Clinic profile</h2></div>
      <div className="form" style={{ paddingTop: 16 }}>
        <label className="field">
          <span>Clinic name</span>
          <input value={form.clinicName} onChange={(e) => set('clinicName', e.target.value)} required minLength={2} />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Phone</span>
            <input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+355 …" />
          </label>
          <label className="field">
            <span>Email</span>
            <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="info@clinic.com" />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Address</span>
            <input value={form.address} onChange={(e) => set('address', e.target.value)} />
          </label>
          <label className="field">
            <span>City</span>
            <input value={form.city} onChange={(e) => set('city', e.target.value)} />
          </label>
        </div>
        {error && <p className="formerror">{error}</p>}
        <div className="form__foot"><SaveButton busy={busy} saved={saved} /></div>
      </div>
    </form>
  );
}

function HoursCard({ initial }: { initial: WorkingDay[] }) {
  const [hours, setHours] = useState<WorkingDay[]>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setDay = (i: number, patch: Partial<WorkingDay>) => {
    setSaved(false);
    setHours((h) => h.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await settingsApi.update({ workingHours: hours });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally { setBusy(false); }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>Working hours</h2>
          <p className="card__sub">These drive the reservation calendar.</p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 12, gap: 6 }}>
        {hours.map((d, i) => (
          <div className="hours-row" key={d.day}>
            <span className="hours-row__day">{DAY_NAMES[d.day]}</span>
            <label className="hours-row__closed">
              <input type="checkbox" checked={!d.closed}
                onChange={(e) => setDay(i, { closed: !e.target.checked })} />
              <span>{d.closed ? 'Closed' : 'Open'}</span>
            </label>
            {!d.closed && (
              <span className="hours-row__times">
                <input type="time" value={d.open} onChange={(e) => setDay(i, { open: e.target.value })} required />
                <span className="muted">–</span>
                <input type="time" value={d.close} onChange={(e) => setDay(i, { close: e.target.value })} required />
              </span>
            )}
          </div>
        ))}
        {error && <p className="formerror">{error}</p>}
        <div className="form__foot"><SaveButton busy={busy} saved={saved} /></div>
      </div>
    </form>
  );
}

function PreferencesCard({ initial, payrollInitial }: { initial: number; payrollInitial: boolean }) {
  const [duration, setDuration] = useState(initial);
  const [payroll, setPayroll] = useState(payrollInitial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await settingsApi.update({ defaultAppointmentDuration: duration, payrollLoggingEnabled: payroll });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally { setBusy(false); }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head"><h2>Preferences</h2></div>
      <div className="form" style={{ paddingTop: 16 }}>
        <label className="field" style={{ maxWidth: 280 }}>
          <span>Default appointment duration</span>
          <select value={duration} onChange={(e) => { setSaved(false); setDuration(Number(e.target.value)); }}>
            {DURATIONS.map((d) => (
              <option key={d} value={d}>{d} minutes</option>
            ))}
          </select>
        </label>
        <label className="hours-row__closed" style={{ width: 'auto' }}>
          <input type="checkbox" checked={payroll}
            onChange={(e) => { setSaved(false); setPayroll(e.target.checked); }} />
          <span style={{ color: 'var(--ink)', fontWeight: 600 }}>
            Salary payment logging on the Staff page
          </span>
        </label>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
          Currency is Euro (EUR) across the product.
        </p>
        {error && <p className="formerror">{error}</p>}
        <div className="form__foot"><SaveButton busy={busy} saved={saved} /></div>
      </div>
    </form>
  );
}


const REMINDER_HOURS = [1, 3, 6, 12, 24, 48, 72];

function RemindersCard({ initial }: { initial: ClinicSettings }) {
  const [enabled, setEnabled] = useState(initial.remindersEnabled);
  const [hours, setHours] = useState(initial.reminderHoursBefore);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await settingsApi.update({ remindersEnabled: enabled, reminderHoursBefore: hours });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally { setBusy(false); }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>Appointment reminders</h2>
          <p className="card__sub">Automatic patient reminders before upcoming appointments.</p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <label className="hours-row__closed" style={{ width: 'auto' }}>
          <input type="checkbox" checked={enabled}
            onChange={(e) => { setSaved(false); setEnabled(e.target.checked); }} />
          <span style={{ color: 'var(--ink)', fontWeight: 600 }}>
            {enabled ? 'Automatic reminders are on' : 'Automatic reminders are off'}
          </span>
        </label>
        <label className="field" style={{ maxWidth: 280 }}>
          <span>Send reminder</span>
          <select value={hours} disabled={!enabled}
            onChange={(e) => { setSaved(false); setHours(Number(e.target.value)); }}>
            {REMINDER_HOURS.map((h) => (
              <option key={h} value={h}>
                {h < 24 ? `${h} hour${h > 1 ? 's' : ''} before` : `${h / 24} day${h > 24 ? 's' : ''} before`}
              </option>
            ))}
          </select>
        </label>
        <div className="channel-note">
          <strong>Delivery channel: Internal log.</strong> SMS / email providers are not connected
          yet — reminders are generated by the scheduler and recorded in the reminder log
          (Reservations → Reminders), where staff can act on them. Connecting a provider later
          requires no change to these settings.
        </div>
        {error && <p className="formerror">{error}</p>}
        <div className="form__foot"><SaveButton busy={busy} saved={saved} /></div>
      </div>
    </form>
  );
}
