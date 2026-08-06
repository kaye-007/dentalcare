import { useEffect, useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, Wallet } from 'lucide-react';
import {
  financeApi,
  ApiError,
  type InvoiceDetail,
  type PaymentMethod,
} from '../lib/api';
import { StatusPill, Modal, Avatar } from '../components/ui';
import { formatMoney } from '../lib/format';

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateTime(s: string) {
  return new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const METHOD_LABEL: Record<PaymentMethod, string> = { cash: 'Cash', card: 'Card', bank: 'Bank' };

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [inv, setInv] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    setInv(await financeApi.getInvoice(id));
  }
  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function cancel() {
    if (!inv) return;
    setError(null);
    try {
      await financeApi.cancelInvoice(inv.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel.');
    }
  }

  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!inv) return <div className="page"><p className="muted">Invoice not found.</p></div>;

  const open = inv.status === 'unpaid' || inv.status === 'partially_paid';

  return (
    <div className="page">
      <Link to="/invoices" className="back"><ChevronLeft size={16} /> All invoices</Link>

      <div className="page__head">
        <div className="page__head-main">
          <h2 className="section-title">{inv.invoiceNumber}</h2>
          <p className="page__meta">
            <Link to={`/patients/${inv.patientId}`} className="link" style={{ fontSize: 13 }}>
              {inv.patientName}
            </Link>
            {' '}· issued {fmtDate(inv.issuedAt)}
          </p>
        </div>
        <div className="page__actions">
          <StatusPill status={inv.status} label={inv.status === 'partially_paid' ? 'Partial' : undefined} />
          {open && inv.paid === 0 && (
            <button className="btn btn--danger-ghost btn--sm" onClick={cancel}>Cancel invoice</button>
          )}
          {open && (
            <button className="btn btn--primary" onClick={() => setPaying(true)}>
              <Wallet size={15} /> Record payment
            </button>
          )}
        </div>
      </div>

      {error && <p className="formerror" style={{ marginBottom: 14 }}>{error}</p>}

      <div className="sumstrip">
        <div><span>Total</span><strong>{formatMoney(inv.total)}</strong></div>
        <div><span>Paid</span><strong>{formatMoney(inv.paid)}</strong></div>
        <div><span>Balance</span><strong className={inv.balance > 0 ? 'sumstrip__due' : ''}>{formatMoney(inv.balance)}</strong></div>
      </div>

      <div className="grid">
        <div className="card span-8">
          <div className="card__head"><h2>Line items</h2></div>
          <table className="table">
            <thead>
              <tr><th>Description</th><th>Qty</th><th>Unit price</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
            </thead>
            <tbody>
              {inv.items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <span style={{ fontWeight: 600 }}>{it.description}</span>
                    {it.treatmentName && it.treatmentName !== it.description && (
                      <span className="muted" style={{ fontSize: 12 }}> · {it.treatmentName}</span>
                    )}
                  </td>
                  <td className="muted">{it.quantity}</td>
                  <td className="muted">{formatMoney(it.unitPrice)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card span-4">
          <div className="card__head"><h2>Payments</h2></div>
          {inv.payments.length === 0 ? (
            <p className="pad muted" style={{ fontSize: 13 }}>No payments recorded yet.</p>
          ) : (
            <ul className="list">
              {inv.payments.map((p) => (
                <li className="row" key={p.id}>
                  <span className="row__main">
                    <span className="row__title">{formatMoney(p.amount)}</span>
                    <span className="row__sub">
                      {fmtDateTime(p.paidAt)}{p.recordedBy ? ` · ${p.recordedBy}` : ''}
                      {p.note ? ` · ${p.note}` : ''}
                    </span>
                  </span>
                  <StatusPill status="neutral" label={METHOD_LABEL[p.method]} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {paying && (
        <PaymentModal
          balance={inv.balance}
          onClose={() => setPaying(false)}
          onSaved={async () => { setPaying(false); await load(); }}
          invoiceId={inv.id}
        />
      )}
    </div>
  );
}

function PaymentModal({
  invoiceId,
  balance,
  onClose,
  onSaved,
}: {
  invoiceId: string;
  balance: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState(balance);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await financeApi.recordPayment(invoiceId, { amount, method, note: note.trim() || undefined });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record payment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Record payment" subtitle={`Outstanding balance: ${formatMoney(balance)}`} onClose={onClose}>
      <form className="modal__body" onSubmit={submit}>
        <div className="grid2">
          <label className="field">
            <span>Amount (€)</span>
            <input type="number" min={1} max={balance} value={amount}
              onChange={(e) => setAmount(Number(e.target.value))} required />
          </label>
          <label className="field">
            <span>Method</span>
            <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="bank">Bank transfer</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" maxLength={300} />
        </label>
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Saving…' : `Record ${formatMoney(amount || 0)}`}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/* ════════ Payments history page ════════ */
export function PaymentsPage() {
  const [items, setItems] = useState<import('../lib/api').PaymentHistoryRow[] | null>(null);
  useEffect(() => {
    financeApi.listPayments().then(setItems);
  }, []);
  const total = (items ?? []).reduce((s, p) => s + p.amount, 0);
  return (
    <div className="page">
      <div className="page__head">
        <div className="page__head-main">
          <h2 className="section-title">Payments</h2>
          <p className="page__meta">{items ? `${items.length} payment(s) · ${formatMoney(total)} collected` : '…'}</p>
        </div>
      </div>
      <div className="card">
        {items === null ? (
          <div className="pad muted">Loading…</div>
        ) : items.length === 0 ? (
          <p className="pad muted">No payments recorded yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Invoice</th><th>Patient</th><th>Method</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td className="muted">{fmtDateTime(p.paidAt)}</td>
                  <td><Link to={`/invoices/${p.invoiceId}`} className="link">{p.invoiceNumber}</Link></td>
                  <td>
                    <div className="namecell"><Avatar name={p.patientName} size={26} /><span>{p.patientName}</span></div>
                  </td>
                  <td><StatusPill status="neutral" label={METHOD_LABEL[p.method]} /></td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
