import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Lock, Check, ChevronLeft, ChevronRight, Wallet } from 'lucide-react';
import {
  settingsApi,
  type ClinicSettings,
  type SettingsPayload,
  type WorkingDay,
  humanError,
} from '../lib/api';
import { CURRENCIES, type CurrencyCode } from '@dentalcare/shared';
import { currencyLabel, setCurrency as applyCurrency } from '../lib/format';
import { useAuth } from '../lib/auth';
import { PageHeader, EmptyState, PageLoading } from '../components/ui';
import { t } from '../lib/strings';
import BrandingCard from '../components/settings/BrandingCard';
import FinanceCard from '../components/settings/FinanceCard';
import ClosuresCard from '../components/settings/ClosuresCard';
import FiscalCard from '../components/settings/FiscalCard';
import FeaturesCard from '../components/settings/FeaturesCard';
import CashDrawerCard from '../components/settings/CashDrawerCard';
import { useFeatures } from '../lib/features';
import { useIsPhone } from '../lib/useIsPhone';
import type { Permission } from '../lib/permissions';

const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
const DURATIONS = [15, 30, 45, 60, 90, 120];

const TABS = [
  { key: 'clinic', label: 'Clinic profile' },
  { key: 'schedule', label: 'Opening hours' },
  { key: 'billing', label: 'Payments & tax' },
  { key: 'drawer', label: 'Cash drawer' },
  { key: 'fiscal', label: 'Fiscalization' },
  { key: 'features', label: 'Modules' },
  { key: 'security', label: 'Security' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

/**
 * Everything a clinic configures, in four groups. Sections of this page are
 * `tab`s; the settings that have their own screen (staff, rooms, prices,
 * WhatsApp) are listed here too, as links, so there is one place to look.
 */
type SettingsEntry =
  | { tab: TabKey; hint: string }
  | { to: string; label: string; hint: string; permission: Permission };
const GROUPS: { label: string; entries: SettingsEntry[] }[] = [
  {
    label: 'Clinic',
    entries: [
      { tab: 'clinic', hint: 'Name, address, tax number, logo' },
      { tab: 'schedule', hint: 'Hours, holidays, visit length' },
      {
        to: '/staff',
        label: 'Staff & doctors',
        hint: 'Accounts, roles, who sees patients',
        permission: 'staff:manage',
      },
      {
        to: '/rooms',
        label: 'Rooms',
        hint: 'Treatment rooms and their hours',
        permission: 'appointments:read',
      },
      {
        to: '/treatments',
        label: 'Services & prices',
        hint: 'The price list',
        permission: 'treatments:read',
      },
    ],
  },
  {
    label: 'Payments',
    entries: [
      { tab: 'billing', hint: 'Currency, VAT, payment methods, invoices' },
      { tab: 'drawer', hint: 'Float, counting, differences' },
      { tab: 'fiscal', hint: 'Tax authority registration' },
    ],
  },
  {
    label: 'Communication',
    entries: [
      {
        to: '/messages/settings',
        label: 'WhatsApp & reminders',
        hint: 'Connection and message templates',
        permission: 'reminders:read',
      },
    ],
  },
  {
    label: 'System',
    entries: [
      { tab: 'features', hint: 'Switch parts of DentalCare on or off' },
      { tab: 'security', hint: 'Two-step sign-in' },
    ],
  },
];
const labelOf = (key: TabKey) => TABS.find((x) => x.key === key)!.label;

export default function SettingsPage() {
  const { can } = useAuth();
  const features = useFeatures();
  const canAccess = can('settings:manage');
  const [settings, setSettings] = useState<ClinicSettings | null>(null);
  const [params, setParams] = useSearchParams();
  const phone = useIsPhone();
  const chosen = TABS.find((x) => x.key === params.get('tab'))?.key;
  const tab: TabKey = chosen ?? 'clinic';
  const drawerOn = features.enabled('cash_drawer');
  // A section is listed only where it can do something for this clinic and
  // this person: the drawer's rules exist once the drawer is switched on.
  const shown = (e: SettingsEntry) =>
    'tab' in e ? e.tab !== 'drawer' || drawerOn : can(e.permission);

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

  if (!settings) return <PageLoading label="Loading settings" />;

  // A phone opens on the list of sections, like a phone's own settings; a
  // section is one tap in and one tap back.
  if (phone && !chosen) {
    return (
      <div className="page">
        <PageHeader title="Settings" />
        {GROUPS.map((g) => {
          const entries = g.entries.filter(shown);
          if (entries.length === 0) return null;
          return (
            <section key={g.label} className="setgroup" aria-label={g.label}>
              <h2 className="setgroup__label">{g.label}</h2>
              <ul className="setgroup__list">
                {entries.map((e) => {
                  const label = 'tab' in e ? labelOf(e.tab) : e.label;
                  const body = (
                    <>
                      <span className="setgroup__text">
                        <span className="setgroup__name">{label}</span>
                        <span className="setgroup__hint">{e.hint}</span>
                      </span>
                      <ChevronRight size={17} aria-hidden />
                    </>
                  );
                  return (
                    <li key={label}>
                      {'tab' in e ? (
                        <button
                          type="button"
                          className="setgroup__row"
                          onClick={() => setParams({ tab: e.tab })}
                        >
                          {body}
                        </button>
                      ) : (
                        <Link to={e.to} className="setgroup__row">
                          {body}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <div className="page">
      {phone ? (
        <>
          <button type="button" className="back" onClick={() => setParams({})}>
            <ChevronLeft size={16} aria-hidden /> Settings
          </button>
          <PageHeader title={labelOf(tab)} />
        </>
      ) : (
        <PageHeader
          title="Settings"
          meta="How the clinic presents itself, opens, bills and reminds"
        />
      )}
      {/* Sections as a grouped list beside the content: one level of
          navigation, readable at a glance, instead of a second row of tabs. */}
      <div className="setlayout">
        {!phone && (
          <nav className="setnav" aria-label="Settings sections">
            {GROUPS.map((g) => {
              const entries = g.entries.filter(shown);
              if (entries.length === 0) return null;
              return (
                <div key={g.label} className="setnav__group">
                  <p className="setnav__label">{g.label}</p>
                  {entries.map((e) =>
                    'tab' in e ? (
                      <button
                        key={e.tab}
                        type="button"
                        aria-current={tab === e.tab ? 'page' : undefined}
                        className={`setnav__item${tab === e.tab ? ' setnav__item--active' : ''}`}
                        onClick={() => setParams({ tab: e.tab }, { replace: true })}
                      >
                        {labelOf(e.tab)}
                      </button>
                    ) : (
                      <Link
                        key={e.to}
                        to={e.to}
                        className="setnav__item setnav__item--link"
                      >
                        {e.label}
                        <ChevronRight size={14} aria-hidden />
                      </Link>
                    ),
                  )}
                </div>
              );
            })}
          </nav>
        )}

        <div className="settings-stack" key={tab}>
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
              <PreferencesCard initial={settings.defaultAppointmentDuration} />
            </>
          )}
          {tab === 'billing' && (
            <>
              <CurrencyCard initial={settings.currency} />
              <FinanceCard settings={settings} onSaved={setSettings} />
            </>
          )}
          {tab === 'fiscal' && <FiscalCard />}
          {tab === 'drawer' &&
            (drawerOn ? (
              <CashDrawerCard />
            ) : (
              <EmptyState
                framed
                icon={<Wallet size={22} />}
                title="The cash drawer is switched off"
                body="Switch it on under Modules to set the float and the counting rules."
              />
            ))}
          {tab === 'features' && <FeaturesCard />}
          {tab === 'security' && <SecurityCard initial={settings.mfaRequiredForAll} />}
        </div>
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
      setError(humanError(err, 'The change could not be saved.'));
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
          <p className="card__sub">
            Printed on every invoice. The NIPT is required for fiscal invoices.
          </p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <div className="grid2">
          <label className="field">
            <span>Clinic name</span>
            <input
              value={form.clinicName}
              onChange={(e) => set('clinicName', e.target.value)}
              required
              minLength={2}
            />
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
            <input
              value={form.registrationNumber}
              onChange={(e) => set('registrationNumber', e.target.value)}
            />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Phone</span>
            <input
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
              placeholder="+355 …"
            />
          </label>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              placeholder="info@clinic.al"
            />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Address</span>
            <input
              value={form.address}
              onChange={(e) => set('address', e.target.value)}
            />
          </label>
          <label className="field">
            <span>City</span>
            <input value={form.city} onChange={(e) => set('city', e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Website</span>
          <input
            value={form.website}
            onChange={(e) => set('website', e.target.value)}
            placeholder="https://clinic.al"
          />
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
          <p className="card__sub">
            Two-step sign-in with an authenticator app. Administrators always need it.
          </p>
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
          <span style={{ color: 'var(--ink)', fontWeight: 600 }}>
            Require two-step sign-in for all staff
          </span>
        </label>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
          Anyone who has not set it up is asked to at their next sign-in. Patient records
          are health data: a password alone is one leaked spreadsheet away from being
          enough.
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
            When the clinic is open. Each clinician's own shifts are set in Rooms &amp;
            hours.
          </p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 12, gap: 6 }}>
        {hours.map((d, i) => (
          <div className="hours-row" key={d.day}>
            <span className="hours-row__day">{DAY_NAMES[d.day]}</span>
            <label className="hours-row__closed">
              <input
                type="checkbox"
                checked={!d.closed}
                onChange={(e) => setDay(i, { closed: !e.target.checked })}
              />
              <span>{d.closed ? 'Closed' : 'Open'}</span>
            </label>
            {!d.closed && (
              <span className="hours-row__times">
                <input
                  type="time"
                  value={d.open}
                  onChange={(e) => setDay(i, { open: e.target.value })}
                  required
                />
                <span className="muted">–</span>
                <input
                  type="time"
                  value={d.close}
                  onChange={(e) => setDay(i, { close: e.target.value })}
                  required
                />
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

function PreferencesCard({ initial }: { initial: number }) {
  const [duration, setDuration] = useState(initial);
  const save = useSave();

  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.run(() => settingsApi.update({ defaultAppointmentDuration: duration }));
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
          Every price, invoice and payment is recorded in this one currency. It can only
          be changed before the clinic records its first price or payment — after that
          every stored amount would silently change meaning, so the change is refused.
        </p>
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="form__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}
