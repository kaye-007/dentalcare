import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownToLine, Banknote, Coins, DoorOpen, Lock, PackageOpen, Wallet } from 'lucide-react';
import { countTotal, formatMoney, type CurrencyCode } from '@dentalcare/shared';
import {
  ApiError,
  drawerApi,
  newIdempotencyKey,
  type DenominationCounts,
  type DrawerCurrent,
  type DrawerSession,
  type DrawerSessionRow,
  type FiscalDeclaration,
  type PinApproval,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { DRAWER_CHANGED_EVENT, announceDrawerChange, useFeatures } from '../lib/features';
import { EmptyState, Modal, PageHeader, StatusPill } from '../components/ui';
import MoneyInput from '../components/MoneyInput';
import CountGrid from '../components/drawer/CountGrid';
import ApprovalFields from '../components/drawer/ApprovalFields';
import CloseDrawerPanel from '../components/drawer/CloseDrawerPanel';
import SessionDetailPanel from '../components/drawer/SessionDetailPanel';
import { BAND_PILL, SESSION_STATUS, dateOf, timeOf, varianceLabel } from '../components/drawer/drawer-text';

/**
 * The cash drawer: the receptionist's own drawer, what needs a manager, and
 * the shift reports — each shown to whoever holds the permission for it.
 */
export default function CashDrawerPage() {
  const { can } = useAuth();
  const { enabled, features } = useFeatures();

  if (features !== null && !enabled('cash_drawer')) {
    return (
      <div className="page page--narrow">
        <PageHeader title="Cash drawer" />
        <EmptyState
          framed
          icon={<Lock size={22} />}
          title="The cash drawer is turned off"
          body="Each receptionist opens a drawer with a float and counts it at the end of the shift."
          action={
            can('settings:manage') ? (
              <Link to="/settings?tab=features" className="btn btn--primary btn--sm">
                Turn it on in Settings
              </Link>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Cash drawer" meta="Floats, counts and differences, one person per drawer" />
      <div className="drawer-page">
        {can('drawer:operate') && <MyDrawer />}
        {can('drawer:read') && <Oversight />}
      </div>
    </div>
  );
}

/* ── the signed-in person's drawer ─────────────────────────── */

function MyDrawer() {
  const { can } = useAuth();
  const [current, setCurrent] = useState<DrawerCurrent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'open' | 'drop' | 'payout' | 'float' | 'no_sale' | 'close'>(null);
  const [chosenDrawer, setChosenDrawer] = useState<string | null>(null);

  const load = useCallback(() => {
    drawerApi
      .current()
      .then((c) => {
        setCurrent(c);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(DRAWER_CHANGED_EVENT, load);
    return () => window.removeEventListener(DRAWER_CHANGED_EVENT, load);
  }, [load]);

  const session = current?.session ?? null;

  const afterChange = (s?: DrawerSession & { fiscalDeclaration?: FiscalDeclaration }) => {
    setDialog(null);
    if (s?.fiscalDeclaration) setNotice(declarationNotice(s.fiscalDeclaration));
    announceDrawerChange();
    load();
  };

  if (error) return <p className="formerror">{error}</p>;
  if (!current) return <p className="muted">Loading your drawer…</p>;

  return (
    <section className="card" aria-labelledby="my-drawer">
      <div className="card__head">
        <div>
          <h2 id="my-drawer">Your drawer</h2>
          {session && (
            <p className="card__sub">
              {session.drawer.name} · opened {timeOf(session.openedAt)} · {session.cashPayments} cash payment
              {session.cashPayments === 1 ? '' : 's'}
            </p>
          )}
        </div>
        {session && <StatusPill status={SESSION_STATUS[session.status].kind} label={SESSION_STATUS[session.status].label} />}
      </div>

      <div className="pad">
        {notice && (
          <p className="channel-note" role="status" style={{ marginTop: 0 }}>
            {notice}
          </p>
        )}

        {!session &&
          (current.drawers.length === 0 ? (
            <EmptyState
              icon={<PackageOpen size={22} />}
              title="No drawers set up yet"
              body={can('settings:manage') ? 'Add a drawer in Settings → Features.' : 'Ask an administrator to add one.'}
            />
          ) : (
            <ul className="drawer-choices">
              {current.drawers.map((d) => (
                <li key={d.id} className="drawer-choice">
                  <span>
                    <strong>{d.name}</strong>
                    <span className="small muted"> · {d.currencies.join(', ')}</span>
                    {d.heldBy && <span className="small muted"> · held by {d.heldBy}</span>}
                  </span>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={Boolean(d.heldBy)}
                    onClick={() => {
                      setChosenDrawer(d.id);
                      setDialog('open');
                    }}
                  >
                    <DoorOpen size={15} aria-hidden /> Open
                  </button>
                </li>
              ))}
            </ul>
          ))}

        {session && (
          <>
            <div className="stats">
              {session.currencies.map((c) => (
                <div className="stat" key={c}>
                  <span className="stat__label">
                    <Banknote size={14} aria-hidden /> {c} in the drawer
                  </span>
                  {session.expected ? (
                    <span className="stat__value">{formatMoney(session.expected[c] ?? 0, c)}</span>
                  ) : (
                    <>
                      <span className="stat__value stat__value--quiet">Hidden until you count</span>
                      <span className="stat__sub">Blind count</span>
                    </>
                  )}
                </div>
              ))}
            </div>

            {session.status === 'open' && (
              <div className="drawer-actions">
                <button type="button" className="btn btn--primary" onClick={() => setDialog('close')}>
                  <Lock size={15} aria-hidden /> Close drawer
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setDialog('drop')}>
                  <ArrowDownToLine size={15} aria-hidden /> To the safe
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setDialog('payout')}>
                  <Wallet size={15} aria-hidden /> Pay out
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setDialog('float')}>
                  <Coins size={15} aria-hidden /> Add cash
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setDialog('no_sale')}>
                  Opened without a sale
                </button>
              </div>
            )}
            {session.status === 'counting' && (
              <div className="drawer-actions">
                <button type="button" className="btn btn--primary" onClick={() => setDialog('close')}>
                  Continue closing
                </button>
              </div>
            )}
            {session.status === 'pending_approval' && (
              <>
                <p className="channel-note" style={{ marginTop: 0 }}>
                  Waiting for a manager to approve the difference. Cash cannot be taken until a new drawer is opened.
                </p>
                <div className="drawer-actions">
                  <button type="button" className="btn btn--primary" onClick={() => setDialog('close')}>
                    Approve with a manager’s PIN
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {dialog === 'open' && (
        <OpenDrawerModal
          current={current}
          initialDrawerId={chosenDrawer}
          onClose={() => setDialog(null)}
          onOpened={afterChange}
        />
      )}
      {session && dialog === 'close' && (
        <CloseDrawerPanel
          session={session}
          onClose={() => {
            setDialog(null);
            load();
          }}
          onChanged={() => load()}
        />
      )}
      {session && (dialog === 'drop' || dialog === 'payout' || dialog === 'float') && (
        <MovementModal kind={dialog} session={session} onClose={() => setDialog(null)} onDone={afterChange} />
      )}
      {session && dialog === 'no_sale' && (
        <NoSaleModal session={session} onClose={() => setDialog(null)} onDone={afterChange} />
      )}
    </section>
  );
}

function declarationNotice(d: FiscalDeclaration): string | null {
  switch (d.status) {
    case 'registered':
      return 'The cash declaration was registered with the tax authority.';
    case 'unreachable':
      return 'The tax authority could not be reached. Declare the cash again from Settings → Fiscalization once it is back.';
    case 'rejected':
    case 'failed':
      return `The tax authority did not accept the cash declaration: ${d.message ?? 'no reason given'}.`;
    default:
      return null;
  }
}

function OpenDrawerModal({
  current,
  initialDrawerId,
  onClose,
  onOpened,
}: {
  current: DrawerCurrent;
  initialDrawerId: string | null;
  onClose: () => void;
  onOpened: (s: DrawerSession & { fiscalDeclaration: FiscalDeclaration }) => void;
}) {
  const free = current.drawers.filter((d) => !d.heldBy);
  const [drawerId, setDrawerId] = useState(
    free.find((d) => d.id === initialDrawerId)?.id ?? free[0]?.id ?? '',
  );
  const drawer = current.drawers.find((d) => d.id === drawerId);
  const [floats, setFloats] = useState<Partial<Record<CurrencyCode, number | null>>>({});
  const [counting, setCounting] = useState<CurrencyCode | null>(null);
  const [counts, setCounts] = useState<Partial<Record<CurrencyCode, DenominationCounts>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useMemo(newIdempotencyKey, []);

  const amountOf = (c: CurrencyCode) =>
    counts[c] ? (countTotal(c, counts[c]!) ?? 0) : (floats[c] ?? drawer?.defaultFloat[c] ?? 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!drawer) return;
    setBusy(true);
    setError(null);
    try {
      const s = await drawerApi.open(
        {
          drawerId: drawer.id,
          floats: drawer.currencies.map((c) => ({
            currency: c,
            amount: amountOf(c),
            ...(counts[c] ? { denominations: counts[c] } : {}),
          })),
        },
        key,
      );
      onOpened(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the drawer.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Open a drawer" subtitle="Check the float before taking any cash" onClose={onClose} wide>
      <form className="modal__body" onSubmit={submit}>
        {free.length > 1 && (
          <label className="field">
            <span>Drawer</span>
            <select value={drawerId} onChange={(e) => setDrawerId(e.target.value)}>
              {free.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {drawer?.currencies.map((c) => (
          <div key={c} className="float-row">
            <label className="field">
              <span>Float in {c}</span>
              {counts[c] ? (
                <input value={formatMoney(amountOf(c), c)} readOnly aria-readonly />
              ) : (
                <MoneyInput value={amountOf(c)} onChange={(v) => setFloats((f) => ({ ...f, [c]: v }))} />
              )}
            </label>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-expanded={counting === c}
              onClick={() => {
                setCounting(counting === c ? null : c);
                setCounts((all) => ({ ...all, [c]: all[c] ?? {} }));
              }}
            >
              {counting === c ? 'Done counting' : 'Count notes'}
            </button>
            {counting === c && (
              <CountGrid currency={c} value={counts[c] ?? {}} onChange={(next) => setCounts((all) => ({ ...all, [c]: next }))} />
            )}
          </div>
        ))}
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={busy || !drawer}>
              {busy ? 'Opening…' : 'Open drawer'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function MovementModal({
  kind,
  session,
  onClose,
  onDone,
}: {
  kind: 'drop' | 'payout' | 'float';
  session: DrawerSession;
  onClose: () => void;
  onDone: (s: DrawerSession & { fiscalDeclaration?: FiscalDeclaration }) => void;
}) {
  const { can } = useAuth();
  const [currency, setCurrency] = useState<CurrencyCode>(session.currencies[0]!);
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState<PinApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useMemo(newIdempotencyKey, []);
  const needsApproval = kind !== 'drop' && !can('drawer:approve');

  const title = kind === 'drop' ? 'Move cash to the safe' : kind === 'payout' ? 'Pay out cash' : 'Add cash from the safe';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!amount) return setError('Enter an amount.');
    setBusy(true);
    setError(null);
    try {
      const s =
        kind === 'drop'
          ? await drawerApi.drop(session.id, { currency, amount, reason: reason.trim() || undefined }, key)
          : await drawerApi.approvedMovement(
              kind,
              session.id,
              { currency, amount, reason, approval: approval ?? undefined },
              key,
            );
      onDone(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form className="modal__body" onSubmit={submit}>
        <div className="grid2">
          {session.currencies.length > 1 && (
            <label className="field">
              <span>Currency</span>
              <select value={currency} onChange={(e) => setCurrency(e.target.value as CurrencyCode)}>
                {session.currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Amount</span>
            <MoneyInput value={amount} onChange={setAmount} required />
          </label>
        </div>
        <label className="field">
          <span>{kind === 'drop' ? 'Note (optional)' : 'What it is for'}</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={kind === 'drop' ? undefined : 3}
            maxLength={300}
            required={kind !== 'drop'}
            placeholder={kind === 'payout' ? 'e.g. courier for the lab' : undefined}
          />
        </label>
        {needsApproval && <ApprovalFields value={approval} onChange={setApproval} />}
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={busy || (needsApproval && !approval)}>
              {busy ? 'Saving…' : amount ? `${title.split(' ')[0]} ${formatMoney(amount, currency)}` : title}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function NoSaleModal({
  session,
  onClose,
  onDone,
}: {
  session: DrawerSession;
  onClose: () => void;
  onDone: (s: DrawerSession) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      onDone(await drawerApi.noSale(session.id, reason));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Opened without a sale" subtitle="Recorded against your drawer with the reason" onClose={onClose}>
      <form className="modal__body" onSubmit={submit}>
        <label className="field">
          <span>Why the drawer was opened</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required />
        </label>
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={busy}>
              Record
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/* ── oversight: what needs a manager, and the shift reports ───── */

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function Oversight() {
  const [from, setFrom] = useState(isoDaysAgo(7));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [varianceOnly, setVarianceOnly] = useState(false);
  const [rows, setRows] = useState<DrawerSessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    drawerApi
      .sessions({ from, to, varianceOnly })
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  }, [from, to, varianceOnly]);

  useEffect(load, [load]);

  const today = isoDaysAgo(0);
  const attention = (rows ?? []).filter(
    (r) => r.status === 'pending_approval' || (['open', 'counting'].includes(r.status) && r.businessDate < today),
  );

  return (
    <>
      {attention.length > 0 && (
        <section className="card" aria-labelledby="drawer-attention">
          <div className="card__head">
            <h2 id="drawer-attention">Needs a manager</h2>
          </div>
          <ul className="drawer-list pad">
            {attention.map((r) => (
              <li key={r.id} className="drawer-choice">
                <span>
                  <strong>{r.drawer.name}</strong> · {r.openedBy.name} · {dateOf(r.businessDate)}{' '}
                  <StatusPill
                    status={SESSION_STATUS[r.status].kind}
                    label={r.status === 'pending_approval' ? 'Difference to approve' : 'Left open'}
                  />
                </span>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => setOpenId(r.id)}>
                  Review
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="drawer-reports">
        <div className="card__head">
          <h2 id="drawer-reports">Shift reports</h2>
        </div>
        <div className="toolbar toolbar--filters pad">
          <label className="field">
            <span>From</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="checkrow">
            <input type="checkbox" checked={varianceOnly} onChange={(e) => setVarianceOnly(e.target.checked)} />
            <span>Differences only</span>
          </label>
        </div>
        {error && <p className="formerror pad">{error}</p>}
        {rows === null ? (
          <p className="muted pad">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="pad">
            <EmptyState icon={<Banknote size={22} />} title="No drawer sessions in these dates" />
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Drawer</th>
                  <th>Held by</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="row--click" onClick={() => setOpenId(r.id)}>
                    <td>
                      <button type="button" className="table__link linkbtn" onClick={() => setOpenId(r.id)}>
                        {dateOf(r.businessDate)}
                      </button>
                    </td>
                    <td>{r.drawer.name}</td>
                    <td>{r.openedBy.name}</td>
                    <td>
                      <StatusPill status={SESSION_STATUS[r.status].kind} label={SESSION_STATUS[r.status].label} />
                    </td>
                    <td>
                      {r.reviews.length === 0
                        ? '—'
                        : r.reviews.map((v) => (
                            <span key={v.currency} className="result-chip">
                              <StatusPill status={BAND_PILL[v.band].kind} label={varianceLabel(v.variance, v.currency)} />
                            </span>
                          ))}
                    </td>
                    <td className="small muted">
                      {[r.recounted && 'Recounted', r.selfApproved && 'Self-approved', r.voidedAfterClose && 'Void after close']
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openId && (
        <SessionDetailPanel
          sessionId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            load();
            announceDrawerChange();
          }}
        />
      )}
    </>
  );
}
