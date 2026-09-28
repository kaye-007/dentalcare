import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Receipt, Plus } from 'lucide-react';
import {
  ApiError,
  billingApi,
  LEDGER_LABELS,
  type LedgerEntry,
  type PatientLedger,
  humanError,
  newIdempotencyKey,
} from '../lib/api';
import { currencySymbol, formatMoney, toDate } from '../lib/format';
import MoneyInput from './MoneyInput';
import { useAuth } from '../lib/auth';
import { EmptyState, StatusPill, LoadingRows } from './ui';
import { dateLocale } from '../lib/strings';

/**
 * The patient's account: every charge, payment and correction, with a running
 * balance.
 *
 * Corrections are new entries, never edits — which is what makes this a record
 * rather than a cache. Adding one requires `invoices:delete` (admin), because
 * writing off a balance is a financial decision, not a clerical one.
 */
export default function PatientLedgerCard({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  const canRead = can('invoices:read');
  const canAdjust = can('invoices:delete');

  const [ledger, setLedger] = useState<PatientLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    if (!canRead) return;
    billingApi
      .ledger(patientId)
      .then((l) => {
        setLedger(l);
        setError(null);
      })
      .catch((e) => setError(humanError(e)));
  }, [patientId, canRead]);

  useEffect(load, [load]);

  if (!canRead) return null;

  return (
    <section className="card card--record span-12">
      <header className="card__head">
        <h3>
          <Receipt size={16} aria-hidden /> Account ledger
        </h3>
        {canAdjust && !adding && (
          <button className="btn btn--ghost btn--sm" onClick={() => setAdding(true)}>
            <Plus size={14} /> Adjustment
          </button>
        )}
      </header>

      {error && <p className="formerror">{error}</p>}

      {ledger === null ? (
        <LoadingRows rows={3} label="Loading account" />
      ) : (
        <>
          <div className="ledgersummary">
            <div
              className={`ledgerbalance${ledger.balance > 0 ? ' ledgerbalance--owing' : ''}`}
            >
              <span className="stat__label">
                {ledger.balance > 0
                  ? 'Outstanding'
                  : ledger.balance < 0
                    ? 'In credit'
                    : 'Settled'}
              </span>
              <span className="stat__value">{formatMoney(Math.abs(ledger.balance))}</span>
            </div>
            <span className="cell-sub">Charged {formatMoney(ledger.totalCharged)}</span>
            <span className="cell-sub">Credited {formatMoney(ledger.totalCredited)}</span>
          </div>

          {adding && (
            <AdjustmentForm
              patientId={patientId}
              onDone={() => {
                setAdding(false);
                load();
              }}
              onCancel={() => setAdding(false)}
            />
          )}

          {ledger.entries.length === 0 ? (
            <EmptyState
              icon={<Receipt size={20} />}
              title="No account activity"
              body="Charges and payments appear here as invoices are issued and settled."
            />
          ) : (
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="hide-sm">Entry</th>
                  <th>Detail</th>
                  <th className="num">Amount</th>
                  <th className="num hide-sm">Balance</th>
                </tr>
              </thead>
              <tbody>
                {ledger.entries.map((e: LedgerEntry) => (
                  <tr key={e.id}>
                    <td className="muted">
                      {toDate(e.occurredOn).toLocaleDateString(dateLocale(), {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="hide-sm">
                      {/* A charge and a payment are ordinary events, not alerts. */}
                      <StatusPill
                        status={e.amount > 0 ? 'neutral' : 'done'}
                        label={LEDGER_LABELS[e.entryType] ?? e.entryType}
                      />
                    </td>
                    <td>
                      {e.description}
                      {e.actorName && <span className="cell-sub"> · {e.actorName}</span>}
                    </td>
                    {/* Sign is carried by the symbol, not by colour alone. */}
                    <td className="num" style={{ fontWeight: 600 }}>
                      {e.amount > 0 ? '+' : '−'}
                      {formatMoney(Math.abs(e.amount))}
                    </td>
                    <td className="num muted hide-sm">{formatMoney(e.balanceAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function AdjustmentForm({
  patientId,
  onDone,
  onCancel,
}: {
  patientId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [entryType, setEntryType] = useState<'adjustment' | 'write_off' | 'refund'>(
    'write_off',
  );
  const [amount, setAmount] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // One key for this adjustment, however many times it is submitted (0024).
  const [idemKey] = useState(newIdempotencyKey);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!amount || amount <= 0 || !description.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await billingApi.addAdjustment(
        patientId,
        {
          entryType,
          amount,
          description: description.trim(),
        },
        idemKey,
      );
      onDone();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not record the adjustment.');
      setBusy(false);
    }
  }

  const effect =
    entryType === 'write_off'
      ? 'reduces what the patient owes'
      : entryType === 'refund'
        ? 'returns money to the patient'
        : 'increases what the patient owes';

  return (
    <form className="inlineform" onSubmit={submit}>
      <div className="grid2">
        <label className="field">
          <span>Type</span>
          <select
            value={entryType}
            onChange={(e) => setEntryType(e.target.value as typeof entryType)}
            autoFocus
          >
            <option value="write_off">Write off</option>
            <option value="adjustment">Adjustment (charge)</option>
            <option value="refund">Refund</option>
          </select>
        </label>
        <label className="field">
          <span>Amount ({currencySymbol()})</span>
          <MoneyInput value={amount} onChange={setAmount} placeholder="0.00" required />
        </label>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
        Enter a positive amount — this entry {effect}.
      </p>
      <label className="field">
        <span>Reason (recorded permanently)</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Goodwill gesture, billing error, uncollectable…"
          required
          maxLength={300}
        />
      </label>
      {err && <p className="formerror">{err}</p>}
      <div className="inlineform__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy}>
          {busy ? 'Recording…' : 'Record entry'}
        </button>
      </div>
    </form>
  );
}
