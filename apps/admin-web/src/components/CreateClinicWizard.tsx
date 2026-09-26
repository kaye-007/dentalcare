import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  Copy,
  Loader2,
  PartyPopper,
  RefreshCw,
  Rocket,
  Building2,
  X,
} from 'lucide-react';
import {
  api,
  ApiError,
  clinicHost,
  formatEuro,
  generatePassword,
  TENANT_BASE_DOMAIN,
  type Plan,
  type SubdomainCheck,
} from '../lib/api';
import { Modal } from './ui';

const TIMEZONES = [
  'Europe/Tirane',
  'Europe/Belgrade',
  'Europe/Skopje',
  'Europe/Podgorica',
  'Europe/Athens',
  'Europe/Rome',
  'UTC',
];
const CURRENCIES = ['ALL', 'EUR', 'USD', 'GBP', 'CHF'];
const STEPS = ['Clinic', 'Administrator', 'Plan'];

/**
 * Onboarding in three steps: the clinic and its address, the first
 * administrator, then plan and defaults. The subdomain is checked as it is
 * typed, so the last click is not the one that finds it taken.
 *
 * Lives in the shell rather than on the Clinics screen, so "New clinic" works
 * from anywhere — the top bar, the command palette, an empty state.
 */
export default function CreateClinicWizard({
  demo,
  onClose,
  onCreated,
}: {
  demo: boolean;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const navigate = useNavigate();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    clinicName: '',
    subdomain: '',
    address: '',
    city: '',
    phone: '',
    taxNumber: '',
    ownerFullName: '',
    ownerEmail: '',
    // A demo gets a generated password: it has to be handed over on a call,
    // and a human choosing one on the spot picks the same weak one every time.
    ownerPassword: generatePassword(),
    planId: '',
    trialDays: demo ? 7 : 14,
    currency: 'ALL',
    timezone: 'Europe/Tirane',
    phoneCountryCode: '355',
  });
  const [check, setCheck] = useState<SubdomainCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; subdomain: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .plans()
      .then((p) => {
        setPlans(p);
        setForm((f) => (f.planId ? f : { ...f, planId: p[0]?.id ?? '' }));
      })
      .catch(() => setPlans([]));
  }, []);

  const set = (k: keyof typeof form, v: string | number) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Suggest a subdomain from the name until someone types their own.
  const [subdomainTouched, setSubdomainTouched] = useState(false);
  useEffect(() => {
    if (subdomainTouched) return;
    const suggestion = form.clinicName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
    setForm((f) => ({ ...f, subdomain: suggestion }));
  }, [form.clinicName, subdomainTouched]);

  useEffect(() => {
    const name = form.subdomain.trim();
    if (!name) {
      setCheck(null);
      setChecking(false);
      return;
    }
    let stale = false;
    setChecking(true);
    const timer = window.setTimeout(() => {
      api
        .checkSubdomain(name)
        .then((c) => !stale && setCheck(c))
        .catch(() => !stale && setCheck(null))
        .finally(() => !stale && setChecking(false));
    }, 300);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [form.subdomain]);

  const stepValid = [
    form.clinicName.trim().length >= 2 && check?.available === true && !checking,
    form.ownerFullName.trim().length >= 2 &&
      /\S+@\S+\.\S+/.test(form.ownerEmail) &&
      form.ownerPassword.length >= 8,
    true,
  ];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (step < 2) {
      if (stepValid[step]) setStep(step + 1);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await api.createTenant({
        clinicName: form.clinicName.trim(),
        subdomain: form.subdomain.trim().toLowerCase(),
        ownerFullName: form.ownerFullName.trim(),
        ownerEmail: form.ownerEmail.trim(),
        ownerPassword: form.ownerPassword,
        planId: form.planId || undefined,
        trialDays: Number(form.trialDays),
        currency: form.currency,
        timezone: form.timezone,
        phoneCountryCode: form.phoneCountryCode,
        phone: form.phone.trim() || undefined,
        address: form.address.trim() || undefined,
        city: form.city.trim() || undefined,
        taxNumber: form.taxNumber.trim() || undefined,
      });
      // The password is not stored anywhere readable and cannot be shown
      // again, so the dialog stays open on the hand-over screen.
      setCreated(res);
      onCreated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the clinic.');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const handover = [
      `https://${clinicHost(created.subdomain)}`,
      `Email:    ${form.ownerEmail.trim()}`,
      `Password: ${form.ownerPassword}`,
      'Two-step sign-in is set up at the first sign-in.',
    ].join('\n');
    return (
      <Modal
        title={`${form.clinicName.trim()} is live`}
        subtitle={`${demo ? 'Seven days from now it locks to read-only. ' : ''}This password is not stored in readable form — copy it now, it will not be shown again.`}
        icon={PartyPopper}
        iconTone="ok"
        onClose={onClose}
        dismissable={false}
      >
        <div className="modal__body">
          <pre className="handover">{handover}</pre>
          <div className="modal__foot">
            <button
              type="button"
              className="btn btn--ghost modal__foot-left"
              onClick={async () => {
                await navigator.clipboard.writeText(handover);
                setCopied(true);
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy details'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Done
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                onClose();
                navigate(`/tenants/${created.id}`);
              }}
            >
              Open clinic <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const plan = plans.find((p) => p.id === form.planId);

  return (
    <Modal
      title={demo ? 'New demo clinic' : 'New clinic'}
      subtitle={
        demo
          ? 'A seven-day trial for a sales call. It locks to read-only when the week is up.'
          : 'Set up the clinic, its first administrator and its plan.'
      }
      icon={demo ? Rocket : Building2}
      onClose={onClose}
    >
      <form className="modal__body" onSubmit={submit}>
        <ol className="wsteps">
          {STEPS.map((t, i) => (
            <li key={t} data-done={i < step} data-current={i === step}>
              {t}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            <label className="field">
              <span>Clinic name</span>
              <input
                value={form.clinicName}
                onChange={(e) => set('clinicName', e.target.value)}
                placeholder="Klinika Dentare Avicena"
                required
                autoFocus
              />
            </label>
            <label className="field">
              <span>Web address</span>
              <div className="suffixed">
                <input
                  value={form.subdomain}
                  onChange={(e) => {
                    setSubdomainTouched(true);
                    set('subdomain', e.target.value.toLowerCase());
                  }}
                  placeholder="avicena"
                  required
                  aria-describedby="subdomain-check"
                />
                <span>.{TENANT_BASE_DOMAIN}</span>
              </div>
              <SubdomainState
                id="subdomain-check"
                checking={checking}
                check={check}
                empty={!form.subdomain}
              />
            </label>
            <div className="grid2">
              <label className="field">
                <span>Street address</span>
                <input
                  value={form.address}
                  onChange={(e) => set('address', e.target.value)}
                />
              </label>
              <label className="field">
                <span>City</span>
                <input
                  value={form.city}
                  onChange={(e) => set('city', e.target.value)}
                  placeholder="Tiranë"
                />
              </label>
            </div>
            <div className="grid2">
              <label className="field">
                <span>Clinic phone</span>
                <input
                  value={form.phone}
                  onChange={(e) => set('phone', e.target.value)}
                  placeholder="+355 …"
                />
              </label>
              <label className="field">
                <span>NIPT</span>
                <input
                  value={form.taxNumber}
                  onChange={(e) => set('taxNumber', e.target.value.toUpperCase())}
                  placeholder="L12345678A"
                />
              </label>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <label className="field">
              <span>Full name</span>
              <input
                value={form.ownerFullName}
                onChange={(e) => set('ownerFullName', e.target.value)}
                placeholder="Dr. Arben Hoxha"
                required
                autoFocus
              />
            </label>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={form.ownerEmail}
                onChange={(e) => set('ownerEmail', e.target.value)}
                placeholder="arben@avicena.al"
                required
              />
            </label>
            <label className="field">
              <span>Temporary password</span>
              <div className="suffixed">
                <input
                  className="mono"
                  value={form.ownerPassword}
                  onChange={(e) => set('ownerPassword', e.target.value)}
                  minLength={8}
                  required
                />
                <button
                  type="button"
                  className="iconbtn iconbtn--quiet"
                  style={{ alignSelf: 'center', marginRight: 2 }}
                  onClick={() => set('ownerPassword', generatePassword())}
                  title="Generate another"
                  aria-label="Generate another password"
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              <span className="field__hint">
                They change it, and set up two-step sign-in, the first time they sign in.
              </span>
            </label>
          </>
        )}

        {step === 2 && (
          <>
            <div className="grid2">
              <label className="field">
                <span>Plan</span>
                <select
                  value={form.planId}
                  onChange={(e) => set('planId', e.target.value)}
                  autoFocus
                >
                  <option value="">No plan yet</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {formatEuro(p.price_monthly)}/mo
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Trial</span>
                <div className="suffixed">
                  <input
                    type="number"
                    min={0}
                    max={365}
                    value={form.trialDays}
                    onChange={(e) => set('trialDays', e.target.value)}
                  />
                  <span>days</span>
                </div>
              </label>
            </div>
            <div className="grid2">
              <label className="field">
                <span>Currency</span>
                <select
                  value={form.currency}
                  onChange={(e) => set('currency', e.target.value)}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Time zone</span>
                <select
                  value={form.timezone}
                  onChange={(e) => set('timezone', e.target.value)}
                >
                  {TIMEZONES.map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field" style={{ maxWidth: 200 }}>
              <span>Phone country code</span>
              <div className="suffixed">
                <span style={{ borderLeft: 0, borderRight: '1px solid var(--border)' }}>
                  +
                </span>
                <input
                  value={form.phoneCountryCode}
                  onChange={(e) =>
                    set('phoneCountryCode', e.target.value.replace(/\D/g, ''))
                  }
                  maxLength={3}
                />
              </div>
            </label>
            <div className="impact">
              <b>{form.clinicName.trim()}</b> at{' '}
              <b>{clinicHost(form.subdomain || '…')}</b>, run by{' '}
              {form.ownerFullName.trim() || 'its administrator'}.{' '}
              {Number(form.trialDays) > 0
                ? `${form.trialDays}-day trial, then ${plan ? `${plan.name} at ${formatEuro(plan.price_monthly)} a month` : 'no plan yet'}.`
                : plan
                  ? `Billed ${formatEuro(plan.price_monthly)} a month on ${plan.name} from the next run.`
                  : 'No plan yet — it will not be billed until it has one.'}
            </div>
            <p className="hint">
              The clinic can change its currency until it records its first price or
              payment. Fiscal invoices in Albania need lek.
            </p>
          </>
        )}

        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={step === 0 ? onClose : () => setStep(step - 1)}
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          <button className="btn btn--primary" disabled={busy || !stepValid[step]}>
            {step < 2 ? (
              <>
                Continue <ArrowRight size={15} />
              </>
            ) : busy ? (
              'Creating…'
            ) : demo ? (
              'Create demo'
            ) : (
              'Create clinic'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Whether a subdomain can be had, said as it is typed. */
export function SubdomainState({
  id,
  checking,
  check,
  empty,
}: {
  id?: string;
  checking: boolean;
  check: SubdomainCheck | null;
  empty: boolean;
}) {
  if (empty)
    return (
      <span id={id} className="field__hint">
        Letters, numbers and hyphens.
      </span>
    );
  if (checking) {
    return (
      <span id={id} className="check check--wait">
        <Loader2 size={13} aria-hidden /> Checking…
      </span>
    );
  }
  if (!check) return <span id={id} />;
  return check.available ? (
    <span id={id} className="check check--ok">
      <Check size={13} aria-hidden /> Available
    </span>
  ) : (
    <span id={id} className="check check--bad">
      <X size={13} aria-hidden /> {check.reason}
    </span>
  );
}
