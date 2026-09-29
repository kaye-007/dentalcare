import { useState } from 'react';
import { Ban, Check, Wallet } from 'lucide-react';
import {
  ApiError,
  api,
  formatEuro,
  METHOD_LABELS,
  newIdempotencyKey,
  PAYMENT_METHODS,
  type MarkPaidInput,
  type PaymentMethod,
  type SubscriptionInvoice,
} from '../lib/api';
import { monthKey, monthLabel } from '../lib/format';
import { Modal } from './ui';

/**
 * Recording a payment, not taking one. The money arrived in a bank account
 * somewhere; this writes down that it did, with enough reference to find it
 * again when the clinic disputes it a year from now.
 *
 * Shared by the Billing screen and a clinic's own Billing tab, so the two can
 * never record a payment differently.
 */
export default function PaymentModal({
  invoice,
  onClose,
  onDone,
}: {
  invoice: SubscriptionInvoice;
  onClose: () => void;
  onDone: (outcome: 'paid' | 'void') => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [amount, setAmount] = useState(String(invoice.amount / 100));
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  // One key for settling this invoice and one for voiding it, however many
  // times either is pressed while the dialog is open.
  const [payKey] = useState(newIdempotencyKey);
  const [voidKey] = useState(newIdempotencyKey);

  const minor = Math.round(Number(amount) * 100);
  const short = Number.isFinite(minor) && minor < invoice.amount;
  const period = monthLabel(monthKey(invoice.periodStart), 'long');

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const input: MarkPaidInput = { method, amount: minor };
      if (reference.trim()) input.reference = reference.trim();
      if (note.trim()) input.note = note.trim();
      await api.markInvoicePaid(invoice.id, input, payKey);
      onDone('paid');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not record the payment.');
      setBusy(false);
    }
  }

  async function voidIt() {
    if (!note.trim()) {
      setError('Say why this invoice is being voided.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.voidInvoice(invoice.id, note.trim(), voidKey);
      onDone('void');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not void the invoice.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={voiding ? `Void ${invoice.number}` : `Record payment · ${invoice.number}`}
      subtitle={`${invoice.tenantName} · ${period} · ${formatEuro(invoice.amount)}`}
      icon={voiding ? Ban : Wallet}
      iconTone={voiding ? 'danger' : 'ok'}
      onClose={onClose}
    >
      <div className="modal__body">
        {!voiding && (
          <>
            <div className="grid2">
              <label className="field">
                <span>How it arrived</span>
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Amount received</span>
                <div className="suffixed">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <span>EUR</span>
                </div>
              </label>
            </div>
            {short && (
              <p className="banner banner--warn" style={{ margin: 0 }}>
                Less than the invoice. It still closes as paid — record the shortfall in
                the note.
              </p>
            )}
            <label className="field">
              <span>Reference</span>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Bank reference or transaction id"
              />
            </label>
          </>
        )}

        <label className="field">
          <span>{voiding ? 'Why is this being voided?' : 'Note'}</span>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus={voiding}
          />
        </label>

        {error && <p className="formerror">{error}</p>}

        <div className="modal__foot">
          {voiding ? (
            <>
              <button
                className="btn btn--ghost"
                onClick={() => setVoiding(false)}
                disabled={busy}
              >
                Back
              </button>
              <button
                className="btn btn--danger"
                onClick={() => void voidIt()}
                disabled={busy}
              >
                <Ban size={15} aria-hidden /> {busy ? 'Voiding…' : 'Void invoice'}
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn--danger-ghost modal__foot-left"
                onClick={() => {
                  setVoiding(true);
                  setError(null);
                }}
                disabled={busy}
              >
                Void instead
              </button>
              <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={() => void submit()}
                disabled={busy || !Number.isFinite(minor) || minor < 0}
              >
                <Check size={15} aria-hidden /> {busy ? 'Saving…' : 'Record payment'}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
