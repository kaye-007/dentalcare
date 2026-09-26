import { useEffect, useState, type FormEvent } from 'react';
import { CURRENCIES, DEFAULT_VARIANCE_THRESHOLDS, type CurrencyCode } from '@dentalcare/shared';
import { ApiError, drawerApi, type CashDrawer, type DrawerPolicy } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { currentCurrency } from '../../lib/format';
import MoneyInput from '../MoneyInput';
import { StatusPill } from '../ui';
import { SaveButton, useSave } from '../../pages/SettingsPage';

/**
 * The cash drawer's rules, the drawers themselves, and — for the people who
 * approve differences — their own approval PIN.
 */
export default function CashDrawerCard() {
  const { can } = useAuth();
  return (
    <>
      <PolicyCard />
      <DrawersCard />
      {can('drawer:approve') && <PinCard />}
    </>
  );
}

function PolicyCard() {
  const clinic = currentCurrency();
  const [policy, setPolicy] = useState<DrawerPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const save = useSave();

  useEffect(() => {
    drawerApi
      .policy()
      .then(setPolicy)
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  if (loadError) return <p className="formerror">{loadError}</p>;
  if (!policy) return <p className="muted">Loading…</p>;

  const shown: CurrencyCode[] = [clinic, ...(clinic === 'EUR' ? [] : (['EUR'] as CurrencyCode[]))];
  const threshold = (c: CurrencyCode) => policy.thresholds[c] ?? DEFAULT_VARIANCE_THRESHOLDS[c];
  const edit = (next: Partial<DrawerPolicy>) => {
    save.setSaved(false);
    setPolicy({ ...policy, ...next });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!policy) return;
    const out = await save.run(() => drawerApi.updatePolicy(policy));
    if (out) setPolicy(out);
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>Cash drawer rules</h2>
          <p className="card__sub">Apply to sessions opened after saving. An open session keeps the rules it started with.</p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <label className="checkrow">
          <input type="checkbox" checked={policy.blindCount} onChange={(e) => edit({ blindCount: e.target.checked })} />
          <span>
            <strong>Blind counting.</strong> Hide what the drawer should hold until the receptionist has counted it.
          </span>
        </label>
        <label className="field" style={{ maxWidth: 260 }}>
          <span>Recounts allowed at close</span>
          <select value={policy.maxRecounts} onChange={(e) => edit({ maxRecounts: Number(e.target.value) })}>
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'None' : n}
              </option>
            ))}
          </select>
        </label>
        {shown.map((c) => (
          <fieldset key={c} className="fieldset">
            <legend>{c}</legend>
            <div className="grid2">
              <label className="field">
                <span>Default float</span>
                <MoneyInput
                  value={policy.defaultFloat[c] ?? 0}
                  onChange={(v) => edit({ defaultFloat: { ...policy.defaultFloat, [c]: v ?? 0 } })}
                />
              </label>
              <label className="field">
                <span>Accept without a note up to</span>
                <MoneyInput
                  value={threshold(c).tolerance}
                  onChange={(v) =>
                    edit({ thresholds: { ...policy.thresholds, [c]: { ...threshold(c), tolerance: v ?? 0 } } })
                  }
                />
              </label>
              <label className="field">
                <span>Manager approval above</span>
                <MoneyInput
                  value={threshold(c).approval}
                  onChange={(v) =>
                    edit({ thresholds: { ...policy.thresholds, [c]: { ...threshold(c), approval: v ?? 0 } } })
                  }
                />
              </label>
            </div>
          </fieldset>
        ))}
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="card__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}

function DrawersCard() {
  const clinic = currentCurrency();
  const [drawers, setDrawers] = useState<CashDrawer[] | null>(null);
  const [name, setName] = useState('');
  const [currencies, setCurrencies] = useState<CurrencyCode[]>([clinic]);
  const [tcr, setTcr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    drawerApi
      .drawers()
      .then(setDrawers)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await drawerApi.createDrawer({ name: name.trim(), currencies, tcrCode: tcr.trim() || null });
      setName('');
      setTcr('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the drawer.');
    } finally {
      setBusy(false);
    }
  }

  async function setActive(d: CashDrawer, isActive: boolean) {
    setError(null);
    try {
      await drawerApi.updateDrawer(d.id, { isActive });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the drawer.');
    }
  }

  return (
    <section className="card">
      <div className="card__head">
        <div>
          <h2>Drawers</h2>
          <p className="card__sub">One per till. A retired drawer keeps its history.</p>
        </div>
      </div>
      {drawers && drawers.length > 0 && (
        <ul className="feature-list">
          {drawers.map((d) => (
            <li key={d.id} className="feature-row">
              <div className="feature-row__text">
                <span className="inline-row" style={{ gap: 8 }}>
                  <strong>{d.name}</strong>
                  {!d.isActive && <StatusPill status="neutral" label="Retired" />}
                  {d.openSession && <StatusPill status="info" label={`Open · ${d.openSession.heldBy.name}`} />}
                </span>
                <span className="small muted">
                  {d.currencies.join(', ')}
                  {d.tcrCode ? ` · register ${d.tcrCode}` : ''}
                </span>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={Boolean(d.openSession)}
                onClick={() => void setActive(d, !d.isActive)}
              >
                {d.isActive ? 'Retire' : 'Restore'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="form" onSubmit={add} style={{ paddingTop: 16 }}>
        <div className="grid2">
          <label className="field">
            <span>New drawer</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Front desk" maxLength={60} required />
          </label>
          <label className="field">
            <span>Cash register code (optional)</span>
            <input value={tcr} onChange={(e) => setTcr(e.target.value.toLowerCase())} placeholder="Uses the clinic's register" />
          </label>
        </div>
        <fieldset className="fieldset">
          <legend>Currencies it holds</legend>
          <div className="inline-row" style={{ gap: 16, flexWrap: 'wrap' }}>
            {CURRENCIES.map((c) => (
              <label key={c} className="checkrow">
                <input
                  type="checkbox"
                  checked={currencies.includes(c)}
                  disabled={c === clinic}
                  onChange={(e) =>
                    setCurrencies((all) => (e.target.checked ? [...all, c] : all.filter((x) => x !== c)))
                  }
                />
                <span>{c}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p className="formerror">{error}</p>}
        <div className="card__foot">
          <button className="btn btn--primary btn--sm" disabled={busy || !name.trim()}>
            {busy ? 'Adding…' : 'Add drawer'}
          </button>
        </div>
      </form>
    </section>
  );
}

function PinCard() {
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const save = useSave();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pin !== confirm) return save.setError('The two PINs are different.');
    const out = await save.run(() => drawerApi.setApprovalPin(password, pin));
    if (out) {
      setPassword('');
      setPin('');
      setConfirm('');
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__head">
        <div>
          <h2>Your approval PIN</h2>
          <p className="card__sub">
            Approve a cash difference or a payout at a receptionist’s device. The PIN is yours alone; five wrong
            tries lock it for 15 minutes.
          </p>
        </div>
      </div>
      <div className="form" style={{ paddingTop: 16 }}>
        <label className="field">
          <span>Your current password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <div className="grid2">
          <label className="field">
            <span>New PIN (4–8 digits)</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="\d{4,8}"
              maxLength={8}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              required
            />
          </label>
          <label className="field">
            <span>Repeat it</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="\d{4,8}"
              maxLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
              required
            />
          </label>
        </div>
        {save.error && <p className="formerror">{save.error}</p>}
        <div className="card__foot">
          <SaveButton busy={save.busy} saved={save.saved} />
        </div>
      </div>
    </form>
  );
}
