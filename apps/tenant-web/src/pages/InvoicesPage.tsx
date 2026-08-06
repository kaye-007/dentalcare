import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, ReceiptText, Trash2 } from 'lucide-react';
import {
  financeApi,
  treatmentsApi,
  ApiError,
  type InvoiceSummaryRow,
  type LineItemPayload,
  type Treatment,
} from '../lib/api';
import { PageHeader, StatusPill, EmptyState, Modal, Avatar } from '../components/ui';
import PatientPicker from '../components/PatientPicker';
import { formatMoney } from '../lib/format';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'unpaid', label: 'Unpaid' },
  { key: 'partially_paid', label: 'Partial' },
  { key: 'paid', label: 'Paid' },
] as const;

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function InvoicesPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<string>('all');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState<InvoiceSummaryRow[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  async function load() {
    setItems(await financeApi.listInvoices({ q: debouncedQ, status }));
  }
  useEffect(() => {
    setItems(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, debouncedQ]);

  const outstanding = (items ?? [])
    .filter((i) => i.status === 'unpaid' || i.status === 'partially_paid')
    .reduce((s, i) => s + i.balance, 0);

  return (
    <div className="page">
      <PageHeader
        title="Invoices"
        meta={items ? `${items.length} in view · ${formatMoney(outstanding)} outstanding` : '…'}
        actions={
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New invoice
          </button>
        }
      />

      <div className="toolbar">
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab${status === t.key ? ' tab--active' : ''}`}
              onClick={() => setStatus(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="searchbox">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number or patient…" />
        </div>
      </div>

      <div className="card">
        {items === null ? (
          <div className="pad muted">Loading…</div>
        ) : items.length === 0 ? (
          <EmptyState icon={<ReceiptText size={22} />} title="No invoices found"
            body="Create an invoice after a finished appointment or treatment." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Patient</th>
                <th>Date</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="trow" onClick={() => navigate(`/invoices/${i.id}`)}>
                  <td><span style={{ fontWeight: 600 }}>{i.invoiceNumber}</span></td>
                  <td>
                    <div className="namecell">
                      <Avatar name={i.patientName} size={28} />
                      <span>{i.patientName}</span>
                    </div>
                  </td>
                  <td className="muted">{fmtDate(i.issuedAt)}</td>
                  <td>{formatMoney(i.total)}</td>
                  <td className="muted">{formatMoney(i.paid)}</td>
                  <td style={{ fontWeight: i.balance > 0 ? 600 : 400 }}>{formatMoney(i.balance)}</td>
                  <td><StatusPill status={i.status}
                    label={i.status === 'partially_paid' ? 'Partial' : undefined} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <NewInvoiceModal
          onClose={() => setCreating(false)}
          onCreated={async (id) => { setCreating(false); navigate(`/invoices/${id}`); }}
        />
      )}
    </div>
  );
}

interface DraftItem extends LineItemPayload { key: number }

function NewInvoiceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [patientId, setPatientId] = useState('');
  const [patientName, setPatientName] = useState('');
  const [treatments, setTreatments] = useState<Treatment[]>([]);
  const [items, setItems] = useState<DraftItem[]>([
    { key: 1, description: '', quantity: 1, unitPrice: 0 },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    treatmentsApi.list({ status: 'active' }).then(setTreatments).catch(() => setTreatments([]));
  }, []);

  const total = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);

  const setItem = (key: number, patch: Partial<DraftItem>) =>
    setItems((arr) => arr.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  const pickTreatment = (key: number, treatmentId: string) => {
    const t = treatments.find((x) => x.id === treatmentId);
    setItem(key, t
      ? { treatmentId: t.id, description: t.name, unitPrice: t.price }
      : { treatmentId: undefined });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!patientId) { setError('Choose a patient'); return; }
    if (items.some((it) => !it.description.trim())) { setError('Every line needs a description'); return; }
    setError(null);
    setBusy(true);
    try {
      const created = await financeApi.createInvoice({
        patientId,
        items: items.map(({ key: _k, ...rest }) => ({ ...rest, description: rest.description.trim() })),
      });
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the invoice.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal wide title="New invoice" subtitle="Line items from the treatment catalog or custom entries." onClose={onClose}>
      <form className="modal__body" onSubmit={submit}>
        <PatientPicker
          value={patientName}
          onPick={(p) => { setPatientId(p.id); setPatientName(`${p.firstName} ${p.lastName}`); }}
          onClear={() => { setPatientId(''); setPatientName(''); }}
        />

        <div className="lineitems">
          <p className="lineitems__title">Line items</p>
          {items.map((it) => (
            <div className="lineitem" key={it.key}>
              <select
                value={it.treatmentId ?? ''}
                onChange={(e) => pickTreatment(it.key, e.target.value)}
                title="Treatment"
              >
                <option value="">Custom…</option>
                {treatments.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <input
                value={it.description}
                onChange={(e) => setItem(it.key, { description: e.target.value })}
                placeholder="Description"
              />
              <input
                type="number" min={1} value={it.quantity} title="Quantity"
                onChange={(e) => setItem(it.key, { quantity: Math.max(1, Number(e.target.value)) })}
              />
              <input
                type="number" min={0} value={it.unitPrice} title="Unit price (€)"
                onChange={(e) => setItem(it.key, { unitPrice: Math.max(0, Number(e.target.value)) })}
              />
              <span className="lineitem__amount">{formatMoney(it.quantity * it.unitPrice)}</span>
              <button
                type="button" className="note__del" title="Remove line"
                disabled={items.length === 1}
                onClick={() => setItems((arr) => arr.filter((x) => x.key !== it.key))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button
            type="button" className="link"
            onClick={() => setItems((arr) => [...arr, { key: Date.now(), description: '', quantity: 1, unitPrice: 0 }])}
          >
            <Plus size={14} /> Add line
          </button>
        </div>

        <div className="invoice-total">
          <span>Total</span>
          <strong>{formatMoney(total)}</strong>
        </div>

        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create invoice'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
