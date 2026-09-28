import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpFromLine, Banknote, Lock } from 'lucide-react';
import { formatMoney, type CurrencyCode } from '@dentalcare/shared';
import {
  drawerApi,
  humanError,
  newIdempotencyKey,
  type DrawerCurrent,
  type DrawerSession,
  type DrawerSessionRow,
  type FiscalDeclaration,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { DRAWER_CHANGED_EVENT, announceDrawerChange, useFeatures } from '../lib/features';
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  Modal,
  PageHeader,
  PageLoading,
  StatusPill,
} from '../components/ui';
import MoneyInput from '../components/MoneyInput';
import EndDayModal from '../components/drawer/EndDayModal';
import SessionDetailPanel from '../components/drawer/SessionDetailPanel';
import {
  BAND_PILL,
  SESSION_STATUS,
  dateOf,
  timeOf,
  varianceLabel,
} from '../components/drawer/drawer-text';
import { clinicToday, plusDays } from '../lib/clinic-time';

/**
 * The cash drawer: one for the desk. Start the day with the cash in it, take
 * cash payments into it, end the day by counting it. Managers also see what
 * needs them and the past days.
 */
export default function CashDrawerPage() {
  const { can } = useAuth();
  const { enabled, features } = useFeatures();

  // Wait for the clinic's switches: rendering the manager view first would
  // ask for sessions a switched-off drawer refuses.
  if (features === null) return <PageLoading label="Loading the cash drawer" />;

  if (!enabled('cash_drawer')) {
    return (
      <div className="page page--narrow">
        <PageHeader title="Cash drawer" />
        <EmptyState
          framed
          icon={<Lock size={22} />}
          title="The cash drawer is turned off"
          body="Start the day with the cash in the drawer, take cash payments into it, and count it at the end of the day."
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
      <PageHeader title="Cash drawer" />
      <div className="drawer-page">
        {can('drawer:operate') && <TodayDrawer />}
        {can('drawer:read') && <Oversight />}
      </div>
    </div>
  );
}

/* ── today's drawer, shared by the desk ─────────────────────── */

function TodayDrawer() {
  const [current, setCurrent] = useState<DrawerCurrent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'cash_out' | 'end'>(null);

  const load = useCallback(() => {
    drawerApi
      .current()
      .then((c) => {
        setCurrent(c);
        setError(null);
      })
      .catch((e) => setError(humanError(e, 'The drawer could not be loaded.')));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(DRAWER_CHANGED_EVENT, load);
    return () => window.removeEventListener(DRAWER_CHANGED_EVENT, load);
  }, [load]);

  const afterChange = (s?: { fiscalDeclaration?: FiscalDeclaration }) => {
    setDialog(null);
    setNotice(s?.fiscalDeclaration ? declarationNotice(s.fiscalDeclaration) : null);
    announceDrawerChange();
    load();
  };

  if (error)
    return (
      <section className="card">
        <ErrorState body={error} onRetry={load} />
      </section>
    );
  if (!current)
    return (
      <section className="card">
        <LoadingRows rows={2} label="Loading the drawer" />
      </section>
    );

  const session = current.session;

  return (
    <section
      className={`card till${session ? ` till--${session.status}` : ' till--closed'}`}
      aria-labelledby="today-drawer"
    >
      <h2 id="today-drawer" className="sr-only">
        Today’s drawer
      </h2>
      {notice && (
        <p className="channel-note till__notice" role="status">
          {notice}
        </p>
      )}

      {!session && <StartDay current={current} onStarted={afterChange} />}

      {session && (
        <div className="till__open">
          <div className="till__state">
            <StatusPill
              status={SESSION_STATUS[session.status].kind}
              label={SESSION_STATUS[session.status].label}
            />
            <span className="till__since">
              Started by {session.openedBy.name} at {timeOf(session.openedAt)} ·{' '}
              {session.cashPayments === 1
                ? '1 cash payment'
                : `${session.cashPayments} cash payments`}
            </span>
          </div>

          {/* The one number the drawer is about. A blind count keeps it back
              from the person counting — that is the point of a blind count. */}
          <div className="till__figures">
            {session.currencies.map((c) => (
              <div className="till__figure" key={c}>
                <span className="till__label">
                  <Banknote size={15} aria-hidden />{' '}
                  {session.currencies.length > 1 ? `Expected ${c}` : 'Expected cash'}
                </span>
                {session.expected ? (
                  <span className="till__amount">
                    {formatMoney(session.expected[c] ?? 0, c)}
                  </span>
                ) : (
                  <span className="till__amount till__amount--blind">
                    Revealed after you count
                  </span>
                )}
              </div>
            ))}
          </div>

          {session.status === 'open' && (
            <div className="drawer-actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setDialog('end')}
              >
                <Lock size={15} aria-hidden /> Close drawer
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setDialog('cash_out')}
              >
                <ArrowUpFromLine size={15} aria-hidden /> Take cash out
              </button>
            </div>
          )}
          {session.status === 'counting' && (
            <div className="drawer-actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setDialog('end')}
              >
                Continue closing
              </button>
            </div>
          )}
          {session.status === 'pending_approval' && (
            <>
              <p className="formwarn">
                The count differs by more than the clinic accepts without a manager. A
                manager approves it before the next day can start.
              </p>
              <div className="drawer-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setDialog('end')}
                >
                  Approve with a manager’s PIN
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {session && dialog === 'end' && (
        <EndDayModal
          session={session}
          onClose={() => {
            setDialog(null);
            load();
          }}
        />
      )}
      {session && dialog === 'cash_out' && (
        <CashOutModal
          session={session}
          onClose={() => setDialog(null)}
          onDone={afterChange}
        />
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

/**
 * The drawer is closed: start the day with the cash that is in it, filled in
 * from last night's count. A clinic with no drawer yet gets one here.
 */
export function StartDay({
  current,
  onStarted,
  submitLabel = 'Start drawer',
}: {
  current: DrawerCurrent;
  onStarted: (s: DrawerSession & { fiscalDeclaration: FiscalDeclaration }) => void;
  submitLabel?: string;
}) {
  // A clinic that still runs several drawers picks one; everyone else never sees this.
  const [drawerId, setDrawerId] = useState(
    current.drawers.length > 1 ? (current.drawers.find((d) => !d.heldBy)?.id ?? '') : '',
  );
  const [amount, setAmount] = useState<number | null>(current.suggestedFloat);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useMemo(newIdempotencyKey, []);
  const currency: CurrencyCode = current.currency;

  // Not a form: it also appears inside the payment form, and forms cannot nest.
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const s = await drawerApi.open(
        {
          ...(drawerId ? { drawerId } : {}),
          floats: [{ currency, amount: amount ?? 0 }],
        },
        key,
      );
      onStarted(s);
    } catch (err) {
      setError(humanError(err, 'The drawer could not be started.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="startday">
      <div className="startday__body">
        <p className="startday__title">Drawer closed</p>
        <p className="muted small">
          Count the cash in it now. Cash payments go in once it is started.
        </p>
        {current.drawers.length > 1 && (
          <label className="field">
            <span>Drawer</span>
            <select
              value={drawerId}
              onChange={(e) => setDrawerId(e.target.value)}
              required
            >
              {current.drawers.map((d) => (
                <option key={d.id} value={d.id} disabled={Boolean(d.heldBy)}>
                  {d.name}
                  {d.heldBy ? ` (open, ${d.heldBy})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="startday__amount">
          <span className="till__label">Opening cash · {currency}</span>
          <MoneyInput
            value={amount}
            onChange={setAmount}
            placeholder="0"
            aria-label="Opening cash"
          />
        </label>
        {error && <p className="formerror">{error}</p>}
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy
            ? 'Starting…'
            : `${submitLabel} with ${formatMoney(amount ?? 0, currency)}`}
        </button>
      </div>
    </div>
  );
}

/** Cash leaving the drawer — to the safe, the bank, a courier — always with what it was for. */
function CashOutModal({
  session,
  onClose,
  onDone,
}: {
  session: DrawerSession;
  onClose: () => void;
  onDone: (s: DrawerSession & { fiscalDeclaration?: FiscalDeclaration }) => void;
}) {
  const [currency, setCurrency] = useState<CurrencyCode>(session.currencies[0]!);
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useMemo(newIdempotencyKey, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!amount) return setError('Enter an amount.');
    setBusy(true);
    setError(null);
    try {
      onDone(
        await drawerApi.drop(
          session.id,
          { currency, amount, reason: reason.trim() },
          key,
        ),
      );
    } catch (err) {
      setError(humanError(err, 'That could not be recorded.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Take cash out"
      subtitle="Recorded against today’s drawer"
      onClose={onClose}
    >
      <form className="modal__body" onSubmit={submit}>
        <div className="grid2">
          {session.currencies.length > 1 && (
            <label className="field">
              <span>Currency</span>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
              >
                {session.currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Amount</span>
            <MoneyInput value={amount} onChange={setAmount} required autoFocus />
          </label>
        </div>
        <label className="field">
          <span>What it is for</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={3}
            maxLength={300}
            required
            placeholder="e.g. to the safe, courier for the lab"
          />
        </label>
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={busy}>
              {busy
                ? 'Saving…'
                : amount
                  ? `Take out ${formatMoney(amount, currency)}`
                  : 'Take cash out'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/* ── oversight: what needs a manager, and the past days ───── */

/** The clinic's date `days` ago (its calendar, not the browser's). */
function isoDaysAgo(days: number): string {
  return plusDays(clinicToday(), -days);
}

/** A past day's flags in words, or '' when it has none. */
function flagsOf(r: DrawerSessionRow): string {
  return [
    r.recounted && 'Recounted',
    r.selfApproved && 'Self-approved',
    r.voidedAfterClose && 'Void after close',
  ]
    .filter(Boolean)
    .join(' · ');
}

function Oversight() {
  const [from, setFrom] = useState(isoDaysAgo(7));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [varianceOnly, setVarianceOnly] = useState(false);
  const [rows, setRows] = useState<DrawerSessionRow[] | null>(null);
  const showFlags = (rows ?? []).some((r) => flagsOf(r) !== '');
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    drawerApi
      .sessions({ from, to, varianceOnly })
      .then(setRows)
      .catch((e) => setError(humanError(e, 'Past days could not be loaded.')));
  }, [from, to, varianceOnly]);

  useEffect(load, [load]);

  const today = isoDaysAgo(0);
  const attention = (rows ?? []).filter(
    (r) =>
      r.status === 'pending_approval' ||
      (['open', 'counting'].includes(r.status) && r.businessDate < today),
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
                  <strong>{r.drawer.name}</strong> · {r.openedBy.name} ·{' '}
                  {dateOf(r.businessDate)}{' '}
                  <StatusPill
                    status={SESSION_STATUS[r.status].kind}
                    label={
                      r.status === 'pending_approval'
                        ? 'Difference to approve'
                        : 'Left open'
                    }
                  />
                </span>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => setOpenId(r.id)}
                >
                  Review
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="drawer-reports">
        <div className="card__head">
          <h2 id="drawer-reports">Past days</h2>
        </div>
        <div className="toolbar toolbar--filters pad drawerrange">
          <label className="field">
            <span>From</span>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <label className="checkrow">
            <input
              type="checkbox"
              checked={varianceOnly}
              onChange={(e) => setVarianceOnly(e.target.checked)}
            />
            <span>Differences only</span>
          </label>
        </div>
        {error && <p className="formerror pad">{error}</p>}
        {rows === null ? (
          <LoadingRows rows={3} label="Loading past days" />
        ) : rows.length === 0 ? (
          <div className="pad">
            <EmptyState
              icon={<Banknote size={22} />}
              title="No drawer sessions in these dates"
            />
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {/* Flags only earn a column on the days that have one. */}
                  <th>Day</th>
                  <th className="hide-sm hide-md">Drawer</th>
                  <th className="hide-sm">Started by</th>
                  <th className="hide-sm">Status</th>
                  <th>Result</th>
                  {showFlags && <th className="hide-sm">Flags</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="row--click" onClick={() => setOpenId(r.id)}>
                    <td>
                      <button
                        type="button"
                        className="table__link linkbtn"
                        onClick={() => setOpenId(r.id)}
                      >
                        {dateOf(r.businessDate)}
                      </button>
                      {/* On a phone: who ran the drawer, under the day. */}
                      <span className="cell-sub only-sm">{r.openedBy.name}</span>
                    </td>
                    <td className="hide-sm hide-md">{r.drawer.name}</td>
                    <td className="hide-sm">{r.openedBy.name}</td>
                    <td className="hide-sm">
                      <StatusPill
                        status={SESSION_STATUS[r.status].kind}
                        label={SESSION_STATUS[r.status].label}
                      />
                    </td>
                    <td>
                      {r.reviews.length === 0 ? (
                        <>
                          <span className="hide-sm">—</span>
                          {/* A day not yet counted says where it is instead. */}
                          <span className="only-sm">
                            <StatusPill
                              status={SESSION_STATUS[r.status].kind}
                              label={SESSION_STATUS[r.status].label}
                            />
                          </span>
                        </>
                      ) : (
                        r.reviews.map((v) => (
                          <span key={v.currency} className="result-chip">
                            <StatusPill
                              status={BAND_PILL[v.band].kind}
                              label={varianceLabel(v.variance, v.currency)}
                            />
                          </span>
                        ))
                      )}
                      {/* On a phone a day's flags ride under its result. */}
                      {flagsOf(r) && (
                        <span className="cell-sub only-sm">{flagsOf(r)}</span>
                      )}
                    </td>
                    {showFlags && (
                      <td className="small muted hide-sm">{flagsOf(r) || '—'}</td>
                    )}
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
