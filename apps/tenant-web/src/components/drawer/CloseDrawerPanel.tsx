import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
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
} from '../../lib/api';
import { formatMoney as clinicMoney } from '../../lib/format';
import { announceDrawerChange } from '../../lib/features';
import MoneyInput from '../MoneyInput';
import { SidePanel, StatusPill } from '../ui';
import ApprovalFields from './ApprovalFields';
import CountGrid from './CountGrid';
import { BAND_PILL, currencyTabLabel, varianceText } from './drawer-text';

type Step = 'items' | 'cards' | 'count' | 'review' | 'approval' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'items', label: 'Open items' },
  { key: 'cards', label: 'Cards' },
  { key: 'count', label: 'Count' },
  { key: 'review', label: 'Review' },
];

/**
 * End of shift, in four steps that each fit a phone screen:
 *
 *   1 open items   unpaid invoices from this shift — take payment, or confirm
 *                  they stay on the patients' accounts
 *   2 cards        the POS terminal's end-of-day total against the card
 *                  payments recorded
 *   3 count        every currency, note by note; in a blind count nothing on
 *                  this screen says what the drawer should hold
 *   4 review       the difference per currency, a note where one is needed,
 *                  one recount if the clinic allows it, then close
 *
 * A difference above the approval threshold ends in a fifth step: a manager
 * approves here with their PIN, or later from their own device.
 */
export default function CloseDrawerPanel({
  session: initial,
  onClose,
  onChanged,
}: {
  session: DrawerSession;
  onClose: () => void;
  onChanged: (s: DrawerSession) => void;
}) {
  const [session, setSession] = useState(initial);
  const [checklist, setChecklist] = useState<DrawerChecklist | null>(null);
  const [step, setStep] = useState<Step>(initial.status === 'pending_approval' ? 'approval' : 'items');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [acknowledged, setAcknowledged] = useState(false);
  const [cardBatch, setCardBatch] = useState<number | null>(null);
  const [cardNote, setCardNote] = useState('');
  const [tab, setTab] = useState<CurrencyCode>(initial.currencies[0]!);
  const [counts, setCounts] = useState<Partial<Record<CurrencyCode, DenominationCounts>>>({});
  const [result, setResult] = useState<{ lines: CountLine[]; recountsLeft: number } | null>(null);
  const [notes, setNotes] = useState<Partial<Record<CurrencyCode, string>>>({});
  const [approval, setApproval] = useState<PinApproval | null>(null);
  const [approvalReason, setApprovalReason] = useState('');

  // One key per attempt at each money-moving step; a retry of the same attempt reuses it.
  const [countKey, setCountKey] = useState(newIdempotencyKey);
  const closeKey = useMemo(newIdempotencyKey, []);

  // Starting to close moves the session to `counting`, which stops cash
  // being taken into it. Re-entering a session already counted resumes at
  // the review with the latest count.
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
          setResult(latest);
          setStep('review');
        }
        announceDrawerChange();
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [initial.id, initial.status]);

  async function backToOpen() {
    setBusy(true);
    try {
      const s = await drawerApi.cancelCount(session.id);
      onChanged(s);
      announceDrawerChange();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reopen the drawer.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCount(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await drawerApi.submitCount(
        session.id,
        session.currencies.map((c) => ({ currency: c, denominations: counts[c] ?? {} })),
        countKey,
      );
      setResult({ lines: out.lines, recountsLeft: out.recountsLeft });
      setStep('review');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the count.');
    } finally {
      setBusy(false);
    }
  }

  function recount() {
    setCounts({});
    setCountKey(newIdempotencyKey());
    setTab(session.currencies[0]!);
    setStep('count');
  }

  async function close() {
    setBusy(true);
    setError(null);
    try {
      const s = await drawerApi.close(
        session.id,
        {
          notes,
          cardBatchTotal: cardBatch ?? undefined,
          cardBatchNote: cardNote.trim() || undefined,
          acknowledgeOpenInvoices: acknowledged || undefined,
        },
        closeKey,
      );
      setSession(s);
      onChanged(s);
      announceDrawerChange();
      setStep(s.status === 'pending_approval' ? 'approval' : 'done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'open_invoices') setStep('items');
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
      const s = await drawerApi.approveWithPin(session.id, { ...approval, reason: approvalReason });
      setSession(s);
      onChanged(s);
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
    (l) => l.band !== 'exact' && (notes[l.currency]?.trim().length ?? 0) < VARIANCE_NOTE_MIN_LENGTH,
  );
  const openInvoices = checklist?.openInvoices ?? [];
  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <SidePanel title={`Close ${session.drawer.name}`} subtitle={`Opened ${new Date(session.openedAt).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}`} onClose={onClose} wide>
      {stepIndex >= 0 && (
        <ol className="wizard-steps" aria-label="Closing steps">
          {STEPS.map((s, i) => (
            <li
              key={s.key}
              className={`wizard-steps__item${i === stepIndex ? ' is-current' : ''}${i < stepIndex ? ' is-done' : ''}`}
              aria-current={i === stepIndex ? 'step' : undefined}
            >
              <span className="wizard-steps__num">{i + 1}</span>
              {s.label}
            </li>
          ))}
        </ol>
      )}

      {step === 'items' && (
        <div className="panel__form">
          <div className="panel__body">
            <h3 className="drawer-h3">Unpaid invoices from this shift</h3>
            {checklist === null ? (
              <p className="muted">Checking…</p>
            ) : openInvoices.length === 0 ? (
              <p className="inline-row" style={{ gap: 8 }}>
                <CheckCircle2 size={16} color="var(--ok-fg)" aria-hidden /> Nothing left unpaid.
              </p>
            ) : (
              <>
                <ul className="drawer-list">
                  {openInvoices.map((i) => (
                    <li key={i.id}>
                      <Link to={`/invoices/${i.id}`} className="table__link">
                        {i.invoiceNumber}
                      </Link>{' '}
                      · {i.patientName} · <strong>{clinicMoney(i.balance)}</strong> due
                    </li>
                  ))}
                </ul>
                <label className="checkrow">
                  <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                  <span>These stay on the patients’ accounts, to be paid later.</span>
                </label>
                <p className="muted small">To take one now, go back to the open drawer first.</p>
              </>
            )}
            {error && <p className="formerror">{error}</p>}
          </div>
          <div className="panel__foot">
            <button type="button" className="btn btn--ghost" onClick={backToOpen} disabled={busy}>
              Back to taking cash
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={checklist === null || (openInvoices.length > 0 && !acknowledged)}
              onClick={() => {
                setError(null);
                setStep('cards');
              }}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 'cards' && checklist && (
        <div className="panel__form">
          <div className="panel__body">
            <h3 className="drawer-h3">Card payments</h3>
            <p>
              {checklist.card.count} card payment{checklist.card.count === 1 ? '' : 's'} recorded, totalling{' '}
              <strong>{clinicMoney(checklist.card.total)}</strong>.
              {checklist.bank.count > 0 && (
                <> Also {checklist.bank.count} bank transfer{checklist.bank.count === 1 ? '' : 's'} ({clinicMoney(checklist.bank.total)}).</>
              )}
            </p>
            {checklist.card.count > 0 && (
              <>
                <label className="field">
                  <span>End-of-day total on the card terminal</span>
                  <MoneyInput value={cardBatch} onChange={setCardBatch} placeholder="From the terminal's report" />
                </label>
                {cardBatch !== null && cardBatch !== checklist.card.total && (
                  <label className="field">
                    <span>
                      The terminal total is {clinicMoney(Math.abs(cardBatch - checklist.card.total))}{' '}
                      {cardBatch > checklist.card.total ? 'more' : 'less'} than the card payments recorded. Why?
                    </span>
                    <input value={cardNote} onChange={(e) => setCardNote(e.target.value)} maxLength={300} />
                  </label>
                )}
              </>
            )}
          </div>
          <div className="panel__foot">
            <button type="button" className="btn btn--ghost" onClick={() => setStep('items')}>
              Back
            </button>
            <button type="button" className="btn btn--primary" onClick={() => setStep(result ? 'review' : 'count')}>
              Next
            </button>
          </div>
        </div>
      )}

      {step === 'count' && (
        <form className="panel__form" onSubmit={submitCount}>
          <div className="panel__body">
            {session.blind && (
              <p className="channel-note" style={{ marginTop: 0 }}>
                Blind count: what the drawer should hold appears once your count is in.
              </p>
            )}
            {session.currencies.length > 1 && (
              <div className="tabs" role="tablist" aria-label="Currency">
                {session.currencies.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="tab"
                    aria-selected={tab === c}
                    className={`tab${tab === c ? ' tab--active' : ''}`}
                    onClick={() => setTab(c)}
                  >
                    {currencyTabLabel(countTotal(c, counts[c] ?? {}) ?? 0, c)}
                  </button>
                ))}
              </div>
            )}
            <CountGrid
              currency={tab}
              value={counts[tab] ?? {}}
              onChange={(next) => setCounts((all) => ({ ...all, [tab]: next }))}
            />
            {error && <p className="formerror">{error}</p>}
          </div>
          <div className="panel__foot">
            <button type="button" className="btn btn--ghost" onClick={() => setStep('cards')}>
              Back
            </button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Saving…' : 'Submit count'}
            </button>
          </div>
        </form>
      )}

      {step === 'review' && result && (
        <div className="panel__form">
          <div className="panel__body">
            {lines.map((l) => (
              <section key={l.currency} className={`variance variance--${l.band}`}>
                <div className="variance__head">
                  <strong>{l.currency}</strong>
                  <StatusPill status={BAND_PILL[l.band].kind} label={BAND_PILL[l.band].label} />
                </div>
                <dl className="variance__figures">
                  <div>
                    <dt>Expected</dt>
                    <dd>{formatMoney(l.expected, l.currency)}</dd>
                  </div>
                  <div>
                    <dt>Counted</dt>
                    <dd>{formatMoney(l.counted, l.currency)}</dd>
                  </div>
                  <div>
                    <dt>Difference</dt>
                    <dd>{varianceText(l.variance, l.currency)}</dd>
                  </div>
                </dl>
                {l.band !== 'exact' && (
                  <label className="field">
                    <span>
                      What happened? {l.band === 'approval' ? 'A manager will read this before approving.' : ''}
                    </span>
                    <textarea
                      rows={2}
                      value={notes[l.currency] ?? ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [l.currency]: e.target.value }))}
                      minLength={VARIANCE_NOTE_MIN_LENGTH}
                      maxLength={300}
                      placeholder="e.g. change given in euro was entered as lek"
                    />
                  </label>
                )}
              </section>
            ))}
            {error && <p className="formerror">{error}</p>}
          </div>
          <div className="panel__foot">
            {result.recountsLeft > 0 && lines.some((l) => l.band !== 'exact') ? (
              <button type="button" className="btn btn--ghost" onClick={recount}>
                Count again
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || Boolean(missingNote)}
              onClick={close}
              title={missingNote ? `Explain the ${missingNote.currency} difference first` : undefined}
            >
              {busy ? 'Closing…' : lines.some((l) => l.band === 'approval') ? 'Close and ask a manager' : 'Close drawer'}
            </button>
          </div>
        </div>
      )}

      {step === 'approval' && (
        <form className="panel__form" onSubmit={approveHere}>
          <div className="panel__body">
            <p className="channel-note" style={{ marginTop: 0 }}>
              The difference is above what the clinic accepts without a manager. A manager can approve here with
              their PIN, or from their own device — you can leave the drawer waiting.
            </p>
            {session.reviews.map((r) => (
              <p key={r.currency} className="inline-row" style={{ gap: 8 }}>
                <StatusPill status={BAND_PILL[r.band].kind} label={r.currency} /> {varianceText(r.variance, r.currency)}
                {r.note ? ` — “${r.note}”` : ''}
              </p>
            ))}
            <ApprovalFields value={approval} onChange={setApproval} />
            <label className="field">
              <span>Manager’s reason</span>
              <input value={approvalReason} onChange={(e) => setApprovalReason(e.target.value)} minLength={3} maxLength={300} required />
            </label>
            {error && <p className="formerror">{error}</p>}
          </div>
          <div className="panel__foot">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Leave it for a manager
            </button>
            <button className="btn btn--primary" disabled={busy || !approval || approvalReason.trim().length < 3}>
              {busy ? 'Approving…' : 'Approve and close'}
            </button>
          </div>
        </form>
      )}

      {step === 'done' && (
        <div className="panel__form">
          <div className="panel__body">
            <p className="inline-row" style={{ gap: 8, fontSize: 16 }}>
              <CheckCircle2 size={20} color="var(--ok-fg)" aria-hidden /> <strong>{session.drawer.name} is closed.</strong>
            </p>
            {session.reviews.map((r) => (
              <p key={r.currency}>
                {r.currency}: counted {formatMoney(r.counted, r.currency)} · {varianceText(r.variance, r.currency)}
              </p>
            ))}
          </div>
          <div className="panel__foot">
            <span />
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </SidePanel>
  );
}

/** The latest count already on a session, as review lines — for resuming a close. */
function latestLines(s: DrawerSession): { lines: CountLine[]; recountsLeft: number } | null {
  if (!s.counts.length || !s.thresholds) return null;
  const attempt = Math.max(...s.counts.map((c) => c.attempt));
  const lines = s.counts
    .filter((c) => c.attempt === attempt)
    .map((c) => {
      const t = s.thresholds?.[c.currency];
      const variance = c.total - c.expected;
      const band: VarianceBand = t ? varianceBand(variance, t) : variance === 0 ? 'exact' : 'note';
      return { currency: c.currency, counted: c.total, expected: c.expected, variance, band };
    });
  return { lines, recountsLeft: Math.max(0, 1 + s.maxRecounts - attempt) };
}
