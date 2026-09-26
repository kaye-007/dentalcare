import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Archive, Pencil, Plus, RotateCcw, Tag } from 'lucide-react';
import { ApiError, api, formatEuro, type PlanDetail } from '../lib/api';
import { Empty, Modal, SkeletonRows, useConfirm, useToast } from '../components/ui';

/**
 * The price list.
 *
 * A plan's price is read by the billing run at the moment it runs and copied
 * onto each invoice, so a change here is never retroactive: issued invoices
 * keep what they said, and the next run bills the new figure. Plans are never
 * deleted — invoices point at their code — only retired, which stops anyone
 * putting a new clinic on one.
 */
export default function PlansPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [plans, setPlans] = useState<PlanDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlanDetail | 'new' | null>(null);

  const load = useCallback(() => {
    api
      .plansAll()
      .then((p) => {
        setPlans(p);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const active = useMemo(() => (plans ?? []).filter((p) => p.is_active), [plans]);
  const retired = useMemo(() => (plans ?? []).filter((p) => !p.is_active), [plans]);
  const totalMrr = useMemo(() => (plans ?? []).reduce((s, p) => s + p.mrr, 0), [plans]);

  async function setActive(p: PlanDetail, isActive: boolean) {
    if (
      !isActive &&
      !(await confirm({
        title: `Retire ${p.name}?`,
        body:
          p.clinic_count > 0
            ? `The ${p.clinic_count} clinic${p.clinic_count === 1 ? '' : 's'} on it keep it and keep being billed for it. Nobody new can be put on it. It can be brought back at any time.`
            : 'Nobody new can be put on it. It can be brought back at any time.',
        confirmLabel: 'Retire plan',
        icon: Archive,
        tone: 'warn',
      }))
    ) {
      return;
    }
    try {
      await api.updatePlan(p.id, { isActive });
      toast(isActive ? `${p.name} is offered again.` : `${p.name} is retired.`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <div className="page__head-main">
          <h1 className="page__title">Plans</h1>
          <p className="page__meta">
            The price list. A change applies from the next billing run; issued invoices
            keep their price.
          </p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setEditing('new')}
          >
            <Plus size={15} aria-hidden /> New plan
          </button>
        </div>
      </div>

      {error && (
        <p className="formerror" style={{ marginBottom: 16 }}>
          {error}
        </p>
      )}

      {plans === null ? (
        <div className="card">
          <SkeletonRows rows={3} />
        </div>
      ) : plans.length === 0 ? (
        <div className="card">
          <Empty
            icon={Tag}
            title="No plans yet"
            body="A clinic needs a plan before a billing run will invoice it."
            action={
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setEditing('new')}
              >
                <Plus size={15} aria-hidden /> New plan
              </button>
            }
          />
        </div>
      ) : (
        <>
          <div className="plans">
            {active.map((p) => (
              <PlanCard
                key={p.id}
                p={p}
                totalMrr={totalMrr}
                onEdit={() => setEditing(p)}
                onToggle={() => void setActive(p, false)}
              />
            ))}
          </div>

          {retired.length > 0 && (
            <>
              <div className="subhead">
                <h2>Retired</h2>
                <span className="muted">Not offered to new clinics</span>
              </div>
              <div className="plans">
                {retired.map((p) => (
                  <PlanCard
                    key={p.id}
                    p={p}
                    totalMrr={totalMrr}
                    onEdit={() => setEditing(p)}
                    onToggle={() => void setActive(p, true)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {editing && (
        <PlanForm
          plan={editing === 'new' ? null : editing}
          taken={(plans ?? []).map((p) => p.code)}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            toast(message);
            load();
          }}
        />
      )}
    </div>
  );
}

function PlanCard({
  p,
  totalMrr,
  onEdit,
  onToggle,
}: {
  p: PlanDetail;
  totalMrr: number;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const share = totalMrr ? p.mrr / totalMrr : 0;
  return (
    <article className={`plan${p.is_active ? '' : ' plan--retired'}`}>
      <div className="plan__top">
        <div>
          <h3 className="plan__name">{p.name}</h3>
          <div className="plan__code">{p.code}</div>
        </div>
        {p.is_active ? (
          <span className="pill pill--ok">Offered</span>
        ) : (
          <span className="pill pill--neutral">Retired</span>
        )}
      </div>
      <div className="plan__price">
        {formatEuro(p.price_monthly)}
        <small>/ month</small>
      </div>
      <dl className="plan__stats">
        <div>
          <dt>Clinics</dt>
          <dd>{p.clinic_count}</dd>
        </div>
        <div>
          <dt>Paying</dt>
          <dd>{p.paying_count}</dd>
        </div>
        <div>
          <dt>MRR</dt>
          <dd>{formatEuro(p.mrr)}</dd>
        </div>
      </dl>
      <span className="meter" aria-hidden>
        <span className="meter__fill" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="plan__share">{Math.round(share * 100)}% of recurring revenue</span>
      <div className="plan__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onEdit}>
          <Pencil size={14} aria-hidden /> Edit
        </button>
        {p.is_active ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onToggle}>
            <Archive size={14} aria-hidden /> Retire
          </button>
        ) : (
          <button type="button" className="btn btn--ok-ghost btn--sm" onClick={onToggle}>
            <RotateCcw size={14} aria-hidden /> Offer again
          </button>
        )}
      </div>
    </article>
  );
}

/** Suggest a code from a name: "Clinic+" → "clinic_plus". */
function codeFrom(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\+/g, '_plus')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32);
}

function PlanForm({
  plan,
  taken,
  onClose,
  onSaved,
}: {
  plan: PlanDetail | null;
  taken: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(plan?.name ?? '');
  const [code, setCode] = useState(plan?.code ?? '');
  const [codeTouched, setCodeTouched] = useState(false);
  const [price, setPrice] = useState(plan ? String(plan.price_monthly / 100) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!plan && !codeTouched) setCode(codeFrom(name));
  }, [name, plan, codeTouched]);

  const minor = Math.round(Number(price) * 100);
  const priceOk =
    price.trim() !== '' && Number.isFinite(minor) && minor >= 0 && minor <= 1_000_000;
  const codeOk = /^[a-z][a-z0-9_]{1,31}$/.test(code);
  const codeTaken = !plan && taken.includes(code);
  const valid = name.trim().length >= 2 && priceOk && (plan || (codeOk && !codeTaken));
  const priceChanged = plan && priceOk && minor !== plan.price_monthly;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      if (plan) {
        await api.updatePlan(plan.id, {
          ...(name.trim() !== plan.name ? { name: name.trim() } : {}),
          ...(minor !== plan.price_monthly ? { priceMonthly: minor } : {}),
        });
        onSaved(`${name.trim()} saved.`);
      } else {
        await api.createPlan({ code, name: name.trim(), priceMonthly: minor });
        onSaved(`${name.trim()} is on the price list.`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the plan.');
      setBusy(false);
    }
  }

  const unchanged = plan && name.trim() === plan.name && minor === plan.price_monthly;

  return (
    <Modal
      title={plan ? `Edit ${plan.name}` : 'New plan'}
      subtitle={plan ? undefined : 'Clinics can be put on it as soon as it is saved.'}
      icon={Tag}
      onClose={onClose}
    >
      <form className="modal__body" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Professional"
            maxLength={60}
            autoFocus
          />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Code</span>
            <input
              className="mono"
              value={code}
              onChange={(e) => {
                setCodeTouched(true);
                setCode(e.target.value.toLowerCase());
              }}
              disabled={!!plan}
              placeholder="professional"
            />
            <span
              className={`field__hint${codeTaken || (code && !codeOk && !plan) ? ' check--bad' : ''}`}
            >
              {plan
                ? 'Fixed: invoices record it.'
                : codeTaken
                  ? 'Another plan has this code.'
                  : code && !codeOk
                    ? 'Lowercase letters, numbers and _ , starting with a letter.'
                    : 'Printed on invoices. Cannot change later.'}
            </span>
          </label>
          <label className="field">
            <span>Price</span>
            <div className="suffixed">
              <input
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="49"
              />
              <span>EUR / month</span>
            </div>
          </label>
        </div>

        {priceChanged && plan && (
          <div className="impact">
            {plan.paying_count > 0 ? (
              <>
                From the next run, <b>{plan.paying_count}</b> paying clinic
                {plan.paying_count === 1 ? '' : 's'} will be billed{' '}
                <b>{formatEuro(minor)}</b> instead of{' '}
                <b>{formatEuro(plan.price_monthly)}</b>. Recurring revenue from this plan
                goes from <b>{formatEuro(plan.mrr)}</b> to{' '}
                <b>{formatEuro(minor * plan.paying_count)}</b>.
              </>
            ) : (
              <>
                No clinic is paying for this plan yet, so nothing already billed changes.
              </>
            )}
          </div>
        )}

        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={busy || !valid || !!unchanged}>
            {busy ? 'Saving…' : plan ? 'Save changes' : 'Create plan'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
