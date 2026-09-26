import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock, Check } from 'lucide-react';
import {
  settingsApi,
  remindersApi,
  ApiError,
  type ClinicSettings,
  type ReminderChannels,
  type SettingsPayload,
  type WorkingDay,
} from '../lib/api';
import {
  CURRENCIES,
  REMINDER_CHANNELS,
  REMINDER_CHANNEL_NAMES,
  REMINDER_HOURS_OPTIONS,
  REMINDER_LOCALES,
  REMINDER_LOCALE_NAMES,
  REMINDER_PLACEHOLDERS,
  defaultReminderTemplate,
  formatAppointmentTime,
  renderReminder,
  smsSegments,
  unknownPlaceholders,
  type CurrencyCode,
  type ReminderChannelId,
  type ReminderLocale,
} from '@dentalcare/shared';
import { currencyLabel, setCurrency as applyCurrency } from '../lib/format';
import { useAuth } from '../lib/auth';
import { PageHeader, EmptyState } from '../components/ui';
import { t } from '../lib/strings';
import BrandingCard from '../components/settings/BrandingCard';
import FinanceCard from '../components/settings/FinanceCard';
import ClosuresCard from '../components/settings/ClosuresCard';
import FiscalCard from '../components/settings/FiscalCard';
import FeaturesCard from '../components/settings/FeaturesCard';
import CashDrawerCard from '../components/settings/CashDrawerCard';
import { useFeatures } from '../lib/features';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DURATIONS = [15, 30, 45, 60, 90, 120];

const TABS = [
  { key: 'clinic', label: 'Clinic profile' },
  { key: 'schedule', label: 'Hours & holidays' },
  { key: 'billing', label: 'Billing & tax' },
  { key: 'fiscal', label: 'Fiscalization' },
  { key: 'features', label: 'Features' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'security', label: 'Security' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export default function SettingsPage() {
  const { can } = useAuth();
  const features = useFeatures();
  const canAccess = can('settings:manage');
  const [settings, setSettings] = useState<ClinicSettings | null>(null);
  const [params, setParams] = useSearchParams();
  const tab: TabKey = TABS.find((x) => x.key === params.get('tab'))?.key ?? 'clinic';

  useEffect(() => {
    if (canAccess) settingsApi.get().then(setSettings);
  }, [canAccess]);

  if (!canAccess) {
    return (
      <div className="page page--narrow">
        <PageHeader title={t('nav.settings')} />
        <EmptyState
          framed
          icon={<Lock size={22} />}
          title="Administrator access only"
          body="Clinic settings are restricted to the clinic's administrators."
        />
      </div>
    );
  }

  if (!settings)
    return (
      <div className="page">
        <p className="muted">{t('common.loading')}</p>
      </div>
    );

  return (
    <div className="page page--narrow">
      <PageHeader title={t('nav.settings')} meta="How the clinic presents itself, opens, bills and reminds" />
      <div className="tabs settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((x) => (
          <button
            key={x.key}
            role="tab"
            aria-selected={tab === x.key}
            className={`tab${tab === x.key ? ' tab--active' : ''}`}
            onClick={() => setParams({ tab: x.key }, { replace: true })}
          >
            {x.label}
          </button>
        ))}
      </div>

      <div className="settings-stack" role="tabpanel">
        {tab === 'clinic' && (
          <>
            <ProfileCard initial={settings} onSaved={setSettings} />
            <BrandingCard settings={settings} onChange={setSettings} />
          </>
        )}
        {tab === 'schedule' && (
          <>
            <HoursCard initial={settings.workingHours} />
            <ClosuresCard />
            <PreferencesCard
              initial={settings.defaultAppointmentDuration}
              payrollInitial={settings.payrollLoggingEnabled}
            />
          </>
        )}
        {tab === 'billing' && (
          <>
            <CurrencyCard initial={settings.currency} />
            <FinanceCard settings={settings} onSaved={setSettings} />
          </>
        )}
        {tab === 'fiscal' && <FiscalCard />}
        {tab === 'features' && (
          <>
            <FeaturesCard />
            {features.enabled('cash_drawer') && <CashDrawerCard />}
          </>
        )}
        {tab === 'reminders' && <RemindersCard initial={settings} />}
        {tab === 'security' && <SecurityCard initial={settings.mfaRequiredForAll} />}
      </div>
    </div>
  );
}

export function SaveButton({ busy, saved }: { busy: boolean; saved: boolean }) {
  return (
    <button className="btn btn--primary btn--sm" disabled={busy}>
      {busy ? (
        'Saving…'
      ) : saved ? (
        <>
          <Check size={14} /> Saved
        </>
      ) : (
        'Save changes'
      )}
    </button>
  );
}

/** Save state shared by every card: busy, saved, and the error to show. */
export function useSave() {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    setBusy(true);
    try {
      const out = await fn();
      setSaved(true);
      return out;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, saved, error, setSaved, setError, run };
}

function ProfileCard({
  initial,
  onSaved,
}: {
  initial: ClinicSettings;
  onSaved: (s: ClinicSettings) => void;
}) {
  const [form, setForm] = useState({
    clinicName: initial.clinicName,
    legalName: initial.legalName ?? '',
    address: initial.address,
    city: initial.city,
    phone: initial.phone,
    email: initial.email,
    website: initial.website ?? '',
    taxNumber: initial.taxNumber ?? '',
    registrationNumber: initial.registrationNumber ?? '',
  });
  const save = useSave();
  const set = (k: keyof typeof form, v: string) => {
    save.setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: SettingsPayload = {
      clinicName: form.clinicName,
      address: form.address,
      city: form.city,
      phone: form.phone,
      email: form.email,
      // Blank clears these; the API reads null as "remove".
      legalName: form.legalName.trim() || null,
      website: form.website.trim() || null,
      taxNumber: form.taxNumber.trim() || null,
      registrationNumber: form.registrationNumber.trim() || null,
    };
    const out = await save.run(() => settingsApi.update(payload));
    if (out) onSaved(out);
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>Clinic profile</h2>
          <p className="card__sub">Printed on every invoice. The NIPT is required for fiscal invoices.</p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <div className="grid2">
          <label className="field">
            <span>Clinic name</span>
            <input value={form.clinicName} onChange={(e) => set('clinicName', e.target.value)} required minLength={2} />
          </label>
          <label className="field">
            <span>Registered business name</span>
            <input
              value={form.legalName}
              onChange={(e) => set('legalName', e.target.value)}
              placeholder="As registered with QKB, if different"
            />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Tax number (NIPT)</span>
            <input
              value={form.taxNumber}
              onChange={(e) => set('taxNumber', e.target.value.toUpperCase())}
              placeholder="L12345678A"
              maxLength={20}
            />
          </label>
          <label className="field">
            <span>Registration / licence number</span>
            <input value={form.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Phone</span>
            <input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+355 …" />
          </label>
          <label className="field">
            <span>Email</span>
            <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="info@clinic.al" />
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
        <label className="field">
          <span>Website</span>
          <input value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="https://clinic.al" />
        </label>
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}

/**
 * Who must use two-step sign-in. Administrators always must — that floor is
 * enforced by the API and is not a setting — so the only choice here is
 * whether to extend it to everyone.
 */
function SecurityCard({ initial }: { initial: boolean }) {
  const [all, setAll] = useState(initial);
  const save = useSave();

  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.run(() => settingsApi.update({ mfaRequiredForAll: all }));
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>Sign-in security</h2>
          <p className="card__sub">Two-step sign-in with an authenticator app. Administrators always need it.</p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <label className="hours-row__closed" style={{ width: 'auto' }}>
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => {
              save.setSaved(false);
              setAll(e.target.checked);
            }}
          />
          <span style={{ color: 'var(--ink)', fontWeight: 600 }}>Require two-step sign-in for all staff</span>
        </label>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
          Anyone who has not set it up is asked to at their next sign-in. Patient records are health data: a
          password alone is one leaked spreadsheet away from being enough.
        </p>
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}

function HoursCard({ initial }: { initial: WorkingDay[] }) {
  const [hours, setHours] = useState<WorkingDay[]>(initial);
  const save = useSave();

  const setDay = (i: number, patch: Partial<WorkingDay>) => {
    save.setSaved(false);
    setHours((h) => h.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.run(() => settingsApi.update({ workingHours: hours }));
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>Opening hours</h2>
          <p className="card__sub">
            When the clinic is open. Each clinician's own shifts are set in Rooms &amp; hours.
          </p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 12, gap: 6 }}>
        {hours.map((d, i) => (
          <div className="hours-row" key={d.day}>
            <span className="hours-row__day">{DAY_NAMES[d.day]}</span>
            <label className="hours-row__closed">
              <input type="checkbox" checked={!d.closed} onChange={(e) => setDay(i, { closed: !e.target.checked })} />
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
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}

function PreferencesCard({ initial, payrollInitial }: { initial: number; payrollInitial: boolean }) {
  const [duration, setDuration] = useState(initial);
  const [payroll, setPayroll] = useState(payrollInitial);
  const save = useSave();

  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.run(() =>
      settingsApi.update({ defaultAppointmentDuration: duration, payrollLoggingEnabled: payroll }),
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <h2>Preferences</h2>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <label className="field" style={{ maxWidth: 280 }}>
          <span>Default appointment duration</span>
          <select
            value={duration}
            onChange={(e) => {
              save.setSaved(false);
              setDuration(Number(e.target.value));
            }}
          >
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} minutes
              </option>
            ))}
          </select>
        </label>
        <label className="hours-row__closed" style={{ width: 'auto' }}>
          <input
            type="checkbox"
            checked={payroll}
            onChange={(e) => {
              save.setSaved(false);
              setPayroll(e.target.checked);
            }}
          />
          <span style={{ color: 'var(--ink)', fontWeight: 600 }}>Salary payment logging on the Staff page</span>
        </label>
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}

function CurrencyCard({ initial }: { initial: CurrencyCode }) {
  const [currency, setCurrency] = useState<CurrencyCode>(initial);
  const save = useSave();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (currency === initial) return;
    const out = await save.run(() => settingsApi.update({ currency }));
    if (out) applyCurrency(currency);
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>Currency</h2>
          <p className="card__sub">Fiscal invoices in Albania are issued in lek (ALL).</p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <label className="field" style={{ maxWidth: 280 }}>
          <span>Clinic currency</span>
          <select
            value={currency}
            onChange={(e) => {
              save.setSaved(false);
              setCurrency(e.target.value as CurrencyCode);
            }}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {currencyLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
          Every price, invoice and payment is recorded in this one currency. It can only be changed before the
          clinic records its first price or payment — after that every stored amount would silently change
          meaning, so the change is refused.
        </p>
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}

/** Zones a clinic here is likely to be in. Any stored zone is offered too. */
const COMMON_TIMEZONES = [
  'Europe/Tirane',
  'Europe/Belgrade',
  'Europe/Skopje',
  'Europe/Podgorica',
  'Europe/Athens',
  'Europe/Rome',
  'Europe/Berlin',
  'Europe/Zurich',
  'Europe/London',
  'America/New_York',
  'UTC',
];

function RemindersCard({ initial }: { initial: ClinicSettings }) {
  const hasPhone = Boolean(initial.phone?.trim());
  const [enabled, setEnabled] = useState(initial.remindersEnabled);
  const [hours, setHours] = useState(initial.reminderHoursBefore === 12 ? 12 : 24);
  const [channel, setChannel] = useState<ReminderChannelId>(initial.reminderChannel);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [locale, setLocale] = useState<ReminderLocale>(initial.reminderLocale);
  const [countryCode, setCountryCode] = useState(initial.phoneCountryCode);
  const [custom, setCustom] = useState(initial.reminderTemplate !== null);
  const [template, setTemplate] = useState(
    initial.reminderTemplate ?? defaultReminderTemplate(initial.reminderLocale, hasPhone),
  );
  const [channels, setChannels] = useState<ReminderChannels | null>(null);
  const save = useSave();

  useEffect(() => {
    remindersApi
      .channels()
      .then(setChannels)
      .catch(() => setChannels(null));
  }, []);

  const touch = () => save.setSaved(false);
  const effective = custom && channel !== 'whatsapp_business' ? template : defaultReminderTemplate(locale, hasPhone);
  const unknown = custom ? unknownPlaceholders(template) : [];
  const available: Record<ReminderChannelId, boolean> = {
    sms: channels?.sms ?? false,
    whatsapp_business: channels?.whatsappBusiness ?? false,
    viber: channels?.viber ?? false,
  };

  // What a patient booked for tomorrow at 10:30 would read. Rendered with the
  // same shared function the API sends with, so the preview is the message.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 30, 0, 0);
  let when = { date: '—', time: '—' };
  try {
    when = formatAppointmentTime(tomorrow, timezone, locale);
  } catch {
    // An unknown zone; the API refuses it on save and says so.
  }
  const preview = renderReminder(effective, {
    first_name: 'Ana',
    clinic: initial.clinicName || 'Your clinic',
    date: when.date,
    time: when.time,
    clinic_phone: initial.phone ?? '',
    dentist: 'Dr. Elira Kola',
    clinic_address: [initial.address, initial.city].filter(Boolean).join(', '),
  });
  const cost = smsSegments(preview);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.run(() =>
      settingsApi.update({
        remindersEnabled: enabled,
        reminderHoursBefore: hours,
        reminderChannel: channel,
        timezone,
        reminderLocale: locale,
        phoneCountryCode: countryCode.trim(),
        reminderTemplate: custom ? template : null,
      }),
    );
  }

  const zones = COMMON_TIMEZONES.includes(timezone) ? COMMON_TIMEZONES : [timezone, ...COMMON_TIMEZONES];

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>Automatic appointment reminders</h2>
          <p className="card__sub">Sent to each patient before an upcoming appointment.</p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <label className="hours-row__closed" style={{ width: 'auto' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              touch();
              setEnabled(e.target.checked);
            }}
          />
          <span style={{ color: 'var(--ink)', fontWeight: 600 }}>
            {enabled ? 'Automatic reminders are on' : 'Automatic reminders are off'}
          </span>
        </label>

        <div className="field">
          <span>Send the reminder</span>
          <div className="segmented" role="group" aria-label="When to send">
            {REMINDER_HOURS_OPTIONS.map((h) => (
              <button
                key={h}
                type="button"
                aria-pressed={hours === h}
                disabled={!enabled}
                onClick={() => {
                  touch();
                  setHours(h);
                }}
              >
                {h} hours before
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Channel</span>
          <div className="segmented" role="group" aria-label="Reminder channel">
            {REMINDER_CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={channel === c}
                onClick={() => {
                  touch();
                  setChannel(c);
                }}
                title={available[c] ? undefined : 'Not configured on this deployment'}
              >
                {REMINDER_CHANNEL_NAMES[c]}
                {channels && !available[c] ? ' (unavailable)' : ''}
              </button>
            ))}
          </div>
          <span className="field-hint">
            A patient can choose their own channel on their record. When a channel is not available on this
            deployment, reminders go by SMS, or to the reminder log if SMS is not set up either.
          </span>
        </div>

        <div className="grid2">
          <label className="field">
            <span>Clinic time zone</span>
            <select
              value={timezone}
              onChange={(e) => {
                touch();
                setTimezone(e.target.value);
              }}
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Language of the message</span>
            <select
              value={locale}
              onChange={(e) => {
                touch();
                const next = e.target.value as ReminderLocale;
                setLocale(next);
                if (!custom) setTemplate(defaultReminderTemplate(next, hasPhone));
              }}
            >
              {REMINDER_LOCALES.map((l) => (
                <option key={l} value={l}>
                  {REMINDER_LOCALE_NAMES[l]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field" style={{ maxWidth: 280 }}>
          <span>Country code for local numbers</span>
          <input
            value={countryCode}
            inputMode="numeric"
            maxLength={3}
            pattern="[1-9][0-9]{0,2}"
            onChange={(e) => {
              touch();
              setCountryCode(e.target.value.replace(/[^\d]/g, ''));
            }}
          />
        </label>

        <label className="hours-row__closed" style={{ width: 'auto' }}>
          <input
            type="checkbox"
            checked={custom}
            onChange={(e) => {
              touch();
              setCustom(e.target.checked);
              if (!e.target.checked) setTemplate(defaultReminderTemplate(locale, hasPhone));
            }}
          />
          <span>Write the message ourselves</span>
        </label>
        {custom && (
          <label className="field">
            <span>Message</span>
            <textarea
              rows={3}
              maxLength={480}
              value={template}
              onChange={(e) => {
                touch();
                setTemplate(e.target.value);
              }}
            />
            <span className="field-hint">
              Can use {REMINDER_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}. The treatment is deliberately not
              available: a message is read on a lock screen.
            </span>
          </label>
        )}
        {unknown.length > 0 && (
          <p className="formerror">{unknown.join(', ')} cannot be filled in and would reach the patient as written.</p>
        )}

        <div className="channel-note">
          <strong>What a patient receives:</strong> {preview}
          <br />
          {channel === 'whatsapp_business' ? (
            <span className="muted" style={{ fontSize: 12 }}>
              WhatsApp only lets a business start a conversation with wording Meta has approved, so WhatsApp
              reminders use the approved template with the patient’s name, date, time, dentist and clinic — not
              the clinic’s own wording.
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              {cost.characters} characters · {cost.segments} SMS part{cost.segments === 1 ? '' : 's'}
              {cost.encoding === 'ucs2' ? ' — letters such as ë make each part hold 70 characters instead of 160' : ''}
            </span>
          )}
        </div>

        {channels && !channels.sms && !channels.whatsappBusiness && !channels.viber && (
          <div className="channel-note">
            <strong>Delivery: internal log.</strong> No messaging provider is configured for this deployment, so
            automatic reminders are recorded in the reminder log (Reservations → Reminders) for staff to act on.
          </div>
        )}

        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}
