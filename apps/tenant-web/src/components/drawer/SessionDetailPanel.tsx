import { useEffect, useState, type FormEvent } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { formatMoney, type CurrencyCode } from '@dentalcare/shared';
import {
  ApiError,
  drawerApi,
  type DenominationCounts,
  type DrawerSession,
  humanError,
  newIdempotencyKey,
} from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { SidePanel, StatusPill, LoadingRows } from '../ui';
import CountGrid from './CountGrid';
import {
  BAND_PILL,
  EVENT_LABEL,
  SESSION_STATUS,
  dateOf,
  timeOf,
  varianceLabel,
} from './drawer-text';

/**
 * One drawer session as oversight sees it: every event in order, every count
 * including the recounts, the reviews, who approved what — and whether the
 * event log still verifies, which is the one check that catches a row edited
 * behind the application's back.
 */
export default function SessionDetailPanel({
  sessionId,
  onClose,
  onChanged,
}: {
  sessionId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const [s, setS] = useState<DrawerSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'approve' | 'force'>('view');
  const [reason, setReason] = useState('');
  const [counts, setCounts] = useState<Partial<Record<CurrencyCode, DenominationCounts>>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  // A new key each time an approval or a force-close is started; a retry of
  // the same one reuses it.
  const [actionKey, setActionKey] = useState(newIdempotencyKey);
  const start = (next: 'approve' | 'force') => {
    setActionKey(newIdempotencyKey());
    setMode(next);
  };

  useEffect(() => {
    drawerApi
      .session(sessionId)
      .then(setS)
      .catch((e) => setError(humanError(e)));
  }, [sessionId]);

  async function act(e: FormEvent) {
    e.preventDefault();
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      const next =
        mode === 'approve'
          ? await drawerApi.approve(s.id, reason, actionKey)
          : await drawerApi.forceClose(
              s.id,
              {
                reason,
                counts: s.currencies.map((c) => ({
                  currency: c,
                  denominations: counts[c] ?? {},
                })),
              },
              actionKey,
            );
      setS(next);
      setMode('view');
      setReason('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not complete that.');
    } finally {
      setBusy(false);
    }
  }

  const status = s ? SESSION_STATUS[s.status] : null;
  const mayApprove = can('drawer:approve');

  return (
    <SidePanel
      title={s ? `${s.drawer.name} · ${dateOf(s.businessDate)}` : 'Drawer session'}
      subtitle={
        s
          ? `${s.openedBy.name}, opened ${timeOf(s.openedAt)}${s.closedAt ? `, closed ${timeOf(s.closedAt)}` : ''}`
          : undefined
      }
      onClose={onClose}
      wide
    >
      {!s ? (
        <div className="panel__body">
          {error ? (
            <p className="formerror">{error}</p>
          ) : (
            <LoadingRows rows={3} label="Loading" />
          )}
        </div>
      ) : mode === 'view' ? (
        <div className="panel__form">
          <div className="panel__body">
            <div className="inline-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {status && <StatusPill status={status.kind} label={status.label} />}
              {s.blind && <StatusPill status="neutral" label="Blind count" />}
              {s.chain &&
                (s.chain.valid ? (
                  <span className="inline-row chain chain--ok">
                    <ShieldCheck size={15} aria-hidden /> Event log verified
                  </span>
                ) : (
                  <span className="inline-row chain chain--broken">
                    <ShieldAlert size={15} aria-hidden /> Event log broken at #
                    {s.chain.brokenAtSeq}
                  </span>
                ))}
            </div>

            {s.reviews.length > 0 && (
              <>
                <h3 className="drawer-h3">Result</h3>
                {s.reviews.map((r) => (
                  <div key={r.currency} className={`variance variance--${r.band}`}>
                    <div className="variance__head">
                      <strong>{r.currency}</strong>
                      <StatusPill
                        status={BAND_PILL[r.band].kind}
                        label={varianceLabel(r.variance, r.currency)}
                      />
                    </div>
                    <p className="small">
                      Expected {formatMoney(r.expected, r.currency)} · counted{' '}
                      {formatMoney(r.counted, r.currency)}
                    </p>
                    {r.note && <p className="small">“{r.note}”</p>}
                  </div>
                ))}
              </>
            )}

            {s.cardTotal !== null && (s.cardTotal > 0 || s.cardBatchTotal !== null) && (
              <p className="small">
                Cards recorded {formatMoney(s.cardTotal, s.currencies[0]!)}
                {s.cardBatchTotal !== null &&
                  ` · terminal ${formatMoney(s.cardBatchTotal, s.currencies[0]!)}`}
                {s.cardBatchNote && ` — “${s.cardBatchNote}”`}
              </p>
            )}

            {s.counts.length > 0 && (
              <>
                <h3 className="drawer-h3">Counts</h3>
                <ul className="drawer-list">
                  {s.counts.map((c) => (
                    <li key={`${c.attempt}-${c.currency}`}>
                      Count {c.attempt} · {c.currency} {formatMoney(c.total, c.currency)}{' '}
                      by {c.countedBy ?? '—'} at {timeOf(c.countedAt)}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {s.approvals.length > 0 && (
              <>
                <h3 className="drawer-h3">Approvals</h3>
                <ul className="drawer-list">
                  {s.approvals.map((a) => (
                    <li key={a.id}>
                      {a.approver ?? '—'} ·{' '}
                      {a.method === 'pin' ? 'PIN at the desk' : 'signed in'}
                      {a.selfApproved && ' · as the sole administrator'} · “{a.reason}”
                    </li>
                  ))}
                </ul>
              </>
            )}

            {s.events && (
              <>
                <h3 className="drawer-h3">Every cash movement</h3>
                <table className="table table--compact">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Time</th>
                      <th>What</th>
                      <th className="num">Amount</th>
                      <th>Who</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.events.map((e) => (
                      <tr key={e.seq}>
                        <td>{e.seq}</td>
                        <td>{timeOf(e.occurredAt)}</td>
                        <td>
                          {EVENT_LABEL[e.type] ?? e.type}
                          {e.reason && <div className="small muted">{e.reason}</div>}
                        </td>
                        <td className="num">
                          {e.type === 'no_sale' ? '—' : formatMoney(e.amount, e.currency)}
                        </td>
                        <td>
                          {e.actor ?? '—'}
                          {e.ip && <div className="small muted">{e.ip}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {error && <p className="formerror">{error}</p>}
          </div>
          <div className="panel__foot">
            {/* The API refuses an administrator's own session unless they are the only one. */}
            {mayApprove && ['open', 'counting', 'pending_approval'].includes(s.status) ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => start('force')}
              >
                Count and force-close
              </button>
            ) : (
              <span />
            )}
            {mayApprove && s.status === 'pending_approval' && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => start('approve')}
              >
                Approve variance
              </button>
            )}
          </div>
        </div>
      ) : (
        <form className="panel__form" onSubmit={act}>
          <div className="panel__body">
            {mode === 'force' && (
              <>
                <p className="channel-note" style={{ marginTop: 0 }}>
                  Count what is in the drawer now. The session closes with your count,
                  your name and your reason.
                </p>
                {s.currencies.map((c) => (
                  <div key={c}>
                    <h3 className="drawer-h3">{c}</h3>
                    <CountGrid
                      currency={c}
                      value={counts[c] ?? {}}
                      onChange={(next) => setCounts((all) => ({ ...all, [c]: next }))}
                    />
                  </div>
                ))}
              </>
            )}
            <label className="field">
              <span>
                {mode === 'approve'
                  ? 'Why you accept the difference'
                  : 'Why this drawer is being force-closed'}
              </span>
              <textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={mode === 'force' ? 10 : 3}
                maxLength={300}
                required
              />
            </label>
            {error && <p className="formerror">{error}</p>}
          </div>
          <div className="panel__foot">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setMode('view')}
            >
              Back
            </button>
            <button className="btn btn--primary" disabled={busy}>
              {busy
                ? 'Saving…'
                : mode === 'approve'
                  ? 'Approve and close'
                  : 'Force-close'}
            </button>
          </div>
        </form>
      )}
    </SidePanel>
  );
}
