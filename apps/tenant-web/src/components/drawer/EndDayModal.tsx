import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2 } from 'lucide-react';
import {
  VARIANCE_NOTE_MIN_LENGTH,
  countTotal,
  formatMoney,
  varianceBand,
  type CurrencyCode,
  type VarianceBand,
} from '@dentalcare/shared';
import {
  ApiError,
  drawerApi,
  newIdempotencyKey,
  type CountLine,
  type DenominationCounts,
  type DrawerChecklist,
  type DrawerSession,
  type PinApproval,
  humanError,
} from '../../lib/api';
import { formatMoney as clinicMoney } from '../../lib/format';
import { announceDrawerChange } from '../../lib/features';
import MoneyInput from '../MoneyInput';
import { Modal, StatusPill } from '../ui';
import ApprovalFields from './ApprovalFields';
import CountGrid from './CountGrid';
import { BAND_PILL, varianceText } from './drawer-text';

type Step = 'count' | 'result' | 'approval' | 'done';

/**
 * End of the day, in one window:
 *
 *   count     how much cash is in the drawer — one number, or note by note
 *             for whoever prefers to count that way
 *   result    expected against counted; a difference needs a short note, and
 *             one above the clinic's limit waits for a manager
 *   approval  a manager approves here with their PIN, or later from their
 *             own device
 *
 * Starting stops cash going into the drawer; leaving before anything is
 * counted puts it back to taking cash.
 */
export default function EndDayModal({
  session: initial,
  onClose,
}: {
  session: DrawerSession;
  onClose: () => void;
}) {
  const [session, setSession] = useState(initial);
  const [checklist, setChecklist] = useState<DrawerChecklist | null>(null);
  const [step, setStep] = useState<Step>(
    initial.status === 'pending_approval' ? 'approval' : 'count',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [totals, setTotals] = useState<Partial<Record<CurrencyCode, number | null>>>({});
  const [byNotes, setByNotes] = useState<
    Partial<Record<CurrencyCode, DenominationCounts>>
  >({});
  const [result, setResult] = useState<{
    lines: CountLine[];
    recountsLeft: number;
  } | null>(null);
  const [notes, setNotes] = useState<Partial<Record<CurrencyCode, string>>>({});
  const [approval, setApproval] = useState<PinApproval | null>(null);
  const [approvalReason, setApprovalReason] = useState('');

  // One key per count attempt; a retry of the same attempt reuses it.
  const [countKey, setCountKey] = useState(newIdempotencyKey);
  const closeKey = useMemo(newIdempotencyKey, []);
  const counted = useRef(initial.counts.length > 0);

  useEffect(() => {
    if (initial.status === 'pending_approval') return;
    let cancelled = false;
    drawerApi
      .startCount(initial.id)
      .then(({ session: s, checklist: c }) => {
        if (cancelled) return;
        setSession(s);
        setChecklist(c);
        const latest = latestLines(s);
        if (latest) {
          counted.current = true;
          setResult(latest);
          setStep('result');
        }
        announceDrawerChange();
      })
      .catch((e) => !cancelled && setError(humanError(e)));
    return () => {
      cancelled = true;
    };
  }, [initial.id, initial.status]);

  /** Closing the window before counting goes back to taking cash. */
  async function dismiss() {
    if (!counted.current && session.status === 'counting') {
      await drawerApi.cancelCount(session.id).catch(() => undefined);
      announceDrawerChange();
    }
    onClose();
  }

  const amountOf = (c: CurrencyCode): number | null =>
    byNotes[c] ? (countTotal(c, byNotes[c]!) ?? 0) : (totals[c] ?? null);

  async function submitCount(e: FormEvent) {
    e.preventDefault();
    if (session.currencies.some((c) => amountOf(c) === null)) {
      return setError('Enter how much cash is in the drawer.');
    }
    setBusy(true);
    setError(null);
    try {
      const out = await drawerApi.submitCount(
        session.id,
        session.currencies.map((c) =>
          byNotes[c]
            ? { currency: c, denominations: byNotes[c]! }
            : { currency: c, total: amountOf(c)! },
        ),
        countKey,
      );
      counted.current = true;
      setResult({ lines: out.lines, recountsLeft: out.recountsLeft });
      setStep('result');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the count.');
    } finally {
      setBusy(false);
    }
  }

  function recount() {
    setTotals({});
    setByNotes({});
    setCountKey(newIdempotencyKey());
    setError(null);
    setStep('count');
  }

  async function close() {
    setBusy(true);
    setError(null);
    try {
      // Unpaid invoices are listed on the count step; closing leaves them on
      // the patients' accounts.
      const s = await drawerApi.close(
        session.id,
        { notes, acknowledgeOpenInvoices: true },
        closeKey,
      );
      setSession(s);
      announceDrawerChange();
      setStep(s.status === 'pending_approval' ? 'approval' : 'done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not close the drawer.');
    } finally {
      setBusy(false);
    }
  }

  async function approveHere(e: FormEvent) {
    e.preventDefault();
    if (!approval) return;
    setBusy(true);
    setError(null);
    try {
      const s = await drawerApi.approveWithPin(session.id, {
        ...approval,
        reason: approvalReason,
      });
      setSession(s);
      announceDrawerChange();
      setStep('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not approve.');
    } finally {
      setBusy(false);
    }
  }

  const lines = result?.lines ?? [];
  const missingNote = lines.find(
    (l) =>
      l.band !== 'exact' &&
      (notes[l.currency]?.trim().length ?? 0) < VARIANCE_NOTE_MIN_LENGTH,
  );
  const openInvoices = checklist?.openInvoices ?? [];
  const single = session.currencies.length === 1;

  return (
    <Modal title="Close drawer" subtitle={subtitleFor(step)} onClose={dismiss}>
      {step === 'count' && (
        <form className="modal__body" onSubmit={submitCount}>
          {session.currencies.map((c) => (
            <div key={c} className="endday-count">
              <label className="field">
                <span>{single ? 'Cash in the drawer' : `${c} in the drawer`}</span>
                {byNotes[c] ? (
                  <input
                    value={formatMoney(amountOf(c) ?? 0, c)}
                    readOnly
                    aria-readonly
                  />
                ) : (
                  <MoneyInput
                    value={totals[c] ?? null}
                    onChange={(v) => setTotals((t) => ({ ...t, [c]: v }))}
                    placeholder="Count it and type the total"
                    autoFocus={c === session.currencies[0]}
                  />
                )}
              </label>
              <button
                type="button"
                className="linkbtn small"
                aria-expanded={Boolean(byNotes[c])}
                onClick={() =>
                  setByNotes((all) => {
                    const next = { ...all };
                    if (next[c]) delete next[c];
                    else next[c] = {};
                    return next;
                  })
                }
              >
                {byNotes[c] ? 'Type the total instead' : 'Count note by note instead'}
              </button>
              {byNotes[c] && (
                <CountGrid
                  currency={c}
                  value={byNotes[c]!}
                  onChange={(v) => setByNotes((all) => ({ ...all, [c]: v }))}
                />
              )}
            </div>
          ))}

          {openInvoices.length > 0 && (
            <p className="channel-note">
              {openInvoices.length} invoice{openInvoices.length === 1 ? '' : 's'} from
              today still unpaid (
              {clinicMoney(openInvoices.reduce((sum, i) => sum + i.balance, 0))}). They
              stay on the patients’ accounts.
            </p>
          )}
          {error && <p className="formerror">{error}</p>}
          <div className="modal__foot">
            <div className="modal__foot-right">
              <button type="button" className="btn btn--ghost" onClick={dismiss}>
                Not yet
              </button>
              <button className="btn btn--primary" disabled={busy || checklist === null}>
                {busy ? 'Checking…' : 'Check the count'}
              </button>
            </div>
          </div>
        </form>
      )}

      {step === 'result' && result && (
        <div className="modal__body">
          {lines.map((l) => (
            <section key={l.currency} className={`variance variance--${l.band}`}>
              {!single && (
                <div className="variance__head">
                  <strong>{l.currency}</strong>
                </div>
              )}
              {/* Expected and counted as a sum, and the difference as the
                  answer — the biggest thing in the window. */}
              <dl className="tally">
                <div className="tally__row">
                  <dt>Expected</dt>
                  <dd>{formatMoney(l.expected, l.currency)}</dd>
                </div>
                <div className="tally__row">
                  <dt>Counted</dt>
                  <dd>{formatMoney(l.counted, l.currency)}</dd>
                </div>
                <div className={`tally__row tally__row--diff tally__row--${l.band}`}>
                  <dt>Difference</dt>
                  <dd>
                    {l.variance === 0
                      ? formatMoney(0, l.currency)
                      : `${l.variance > 0 ? '+' : '−'}${formatMoney(Math.abs(l.variance), l.currency)}`}
                  </dd>
                </div>
              </dl>
              <p className={`tally__say tally__say--${l.band}`}>
                {l.variance === 0
                  ? 'The drawer holds exactly what it should.'
                  : l.variance > 0
                    ? `There is ${formatMoney(l.variance, l.currency)} more in the drawer than expected.`
                    : `The drawer is ${formatMoney(-l.variance, l.currency)} short of what it should hold.`}{' '}
                {l.band === 'note'
                  ? 'Say what happened below before closing.'
                  : l.band === 'approval'
                    ? 'That is more than the clinic accepts without a manager: explain it, and a manager approves it.'
                    : ''}
              </p>
              {l.band !== 'exact' && (
                <label className="field">
                  <span>
                    What happened?
                    {l.band === 'approval'
                      ? ' A manager will read this before approving.'
                      : ''}
                  </span>
                  <textarea
                    rows={2}
                    value={notes[l.currency] ?? ''}
                    onChange={(e) =>
                      setNotes((n) => ({ ...n, [l.currency]: e.target.value }))
                    }
                    minLength={VARIANCE_NOTE_MIN_LENGTH}
                    maxLength={300}
                    placeholder="e.g. gave change from my own pocket"
                  />
                </label>
              )}
            </section>
          ))}
          {error && <p className="formerror">{error}</p>}
          <div className="modal__foot">
            {result.recountsLeft > 0 && lines.some((l) => l.band !== 'exact') ? (
              <button type="button" className="btn btn--ghost" onClick={recount}>
                Count again
              </button>
            ) : (
              <span />
            )}
            <div className="modal__foot-right">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || Boolean(missingNote)}
                onClick={close}
                title={missingNote ? 'Explain the difference first' : undefined}
              >
                {busy
                  ? 'Closing…'
                  : lines.some((l) => l.band === 'approval')
                    ? 'Close and ask a manager'
                    : 'Close drawer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'approval' && (
        <form className="modal__body" onSubmit={approveHere}>
          <p className="channel-note" style={{ marginTop: 0 }}>
            The difference is more than the clinic accepts without a manager. A manager
            can approve here with their PIN, or later from their own device.
          </p>
          {session.reviews.map((r) => (
            <p key={r.currency} className="inline-row" style={{ gap: 8 }}>
              <StatusPill
                status={BAND_PILL[r.band].kind}
                label={single ? 'Cash' : r.currency}
              />{' '}
              {varianceText(r.variance, r.currency)}
              {r.note ? ` — “${r.note}”` : ''}
            </p>
          ))}
          <ApprovalFields value={approval} onChange={setApproval} />
          <label className="field">
            <span>Manager’s reason</span>
            <input
              value={approvalReason}
              onChange={(e) => setApprovalReason(e.target.value)}
              minLength={3}
              maxLength={300}
              required
            />
          </label>
          {error && <p className="formerror">{error}</p>}
          <div className="modal__foot">
            <div className="modal__foot-right">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Leave it for a manager
              </button>
              <button
                className="btn btn--primary"
                disabled={busy || !approval || approvalReason.trim().length < 3}
              >
                {busy ? 'Approving…' : 'Approve and close'}
              </button>
            </div>
          </div>
        </form>
      )}

      {step === 'done' && (
        <div className="modal__body paydone">
          <span className="paydone__check" aria-hidden>
            <CheckCircle2 size={28} />
          </span>
          <p className="paydone__method">The drawer is closed.</p>
          {session.reviews.map((r) => (
            <p key={r.currency} className="paydone__amount">
              {formatMoney(r.counted, r.currency)}
            </p>
          ))}
          {session.reviews.map((r) => (
            <p
              key={`v${r.currency}`}
              className={`paydone__left${r.variance !== 0 ? ' paydone__left--owing' : ''}`}
            >
              {varianceText(r.variance, r.currency)}
            </p>
          ))}
          <div className="modal__foot">
            <div className="modal__foot-right">
              <button type="button" className="btn btn--primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function subtitleFor(step: Step): string {
  switch (step) {
    case 'count':
      return 'Count the cash in the drawer';
    case 'result':
      return 'Compare with what the drawer should hold';
    case 'approval':
      return 'Waiting for a manager';
    default:
      return 'All done';
  }
}

/** The latest count already on a session, as result lines — for resuming. */
function latestLines(
  s: DrawerSession,
): { lines: CountLine[]; recountsLeft: number } | null {
  if (!s.counts.length || !s.thresholds) return null;
  const attempt = Math.max(...s.counts.map((c) => c.attempt));
  const lines = s.counts
    .filter((c) => c.attempt === attempt)
    .map((c) => {
      const t = s.thresholds?.[c.currency];
      const variance = c.total - c.expected;
      const band: VarianceBand = t
        ? varianceBand(variance, t)
        : variance === 0
          ? 'exact'
          : 'note';
      return {
        currency: c.currency,
        counted: c.total,
        expected: c.expected,
        variance,
        band,
      };
    });
  return { lines, recountsLeft: Math.max(0, 1 + s.maxRecounts - attempt) };
}
