import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Search, ReceiptText, Trash2 } from 'lucide-react';
import ServicePicker from '../components/ServicePicker';
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
import { useAuth } from '../lib/auth';
import { currencySymbol, formatMoney, toDate } from '../lib/format';
import MoneyInput from '../components/MoneyInput';
import { dateLocale, t, type StringKey } from '../lib/strings';
import { VAT_CATEGORIES, vatCategoryLabel, vatRateFor, type VatCategory } from '@dentalcare/shared';
import { useClinicVatRate } from '../lib/vat';

const TABS: { key: string; label: StringKey }[] = [
  { key: 'all', label: 'invoice.all' },
  { key: 'unpaid', label: 'invoice.status.unpaid' },
  { key: 'partially_paid', label: 'invoice.status.partially_paid' },
  { key: 'paid', label: 'invoice.status.paid' },
];

function fmtDate(s: string) {
  return toDate(s).toLocaleDateString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function InvoicesPage() {
  const navigate = useNavigate();
  const { readOnly } = useAuth();
  const [status, setStatus] = useState<string>('all');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState<InvoiceSummaryRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // "New invoice" from the topbar menu lands here with ?new=1. Open the form
  // once, then drop the flag so a reload does not open it again.
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    setCreating(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('new');
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

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
        meta={
          items
            ? `${items.length} in view · ${formatMoney(outstanding)} outstanding`
            : '…'
        }
        actions={
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> {t('invoice.new')}
          </button>
        }
      />

      <section className="card">
        <div className="card__toolbar">
          <div className="tabs" role="group" aria-label="Filter invoices by status">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`tab${status === tab.key ? ' tab--active' : ''}`}
                aria-pressed={status === tab.key}
                onClick={() => setStatus(tab.key)}
              >
                {t(tab.label)}
              </button>
            ))}
          </div>
          <label className="searchbox">
            <Search size={16} aria-hidden />
            <span className="sr-only">{t('invoice.search')}</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search number or patient…"
            />
          </label>
        </div>
        {items === null ? (
          <div className="pad muted">Loading…</div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ReceiptText size={22} />}
            title={t('invoice.empty.title')}
            body={t('invoice.empty.body')}
            action={
              !readOnly ? (
                <button className="btn btn--primary" onClick={() => setCreating(true)}>
                  <Plus size={16} /> {t('invoice.empty.cta')}
                </button>
              ) : undefined
            }
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('invoice.col.invoice')}</th>
                <th>{t('invoice.col.patient')}</th>
                <th>{t('invoice.col.date')}</th>
                <th>{t('invoice.col.total')}</th>
                <th>{t('invoice.col.paid')}</th>
                <th>{t('invoice.col.balance')}</th>
                <th>{t('invoice.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr
                  key={i.id}
                  className="trow"
                  onClick={() => navigate(`/invoices/${i.id}`)}
                >
                  <td>
                    <span style={{ fontWeight: 600 }}>{i.invoiceNumber}</span>
                  </td>
                  <td>
                    <div className="namecell">
                      <Avatar name={i.patientName} size={28} />
                      <span>{i.patientName}</span>
                    </div>
                  </td>
                  <td className="muted">{fmtDate(i.issuedAt)}</td>
                  <td>{formatMoney(i.total)}</td>
                  <td className="muted">{formatMoney(i.paid)}</td>
                  <td style={{ fontWeight: i.balance > 0 ? 600 : 400 }}>
                    {formatMoney(i.balance)}
                  </td>
                  <td>
                    <StatusPill
                      status={i.status}
                      label={i.status === 'partially_paid' ? 'Partial' : undefined}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {creating && (
        <NewInvoiceModal
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            navigate(`/invoices/${id}`);
          }}
        />
      )}
    </div>
  );
}

interface DraftItem extends LineItemPayload {
  key: number;
  vatCategory: VatCategory;
}

/** The server's arithmetic (billing-engine calculateInvoiceLine), for the preview only. */
function lineTax(it: DraftItem, clinicRateBp: number): number {
  const rate = vatRateFor(it.vatCategory, clinicRateBp);
  return Math.round((it.quantity * it.unitPrice * rate) / 10_000);
}

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
  const [items, setItems] = useState<DraftItem[]>([]);
  const vatRate = useClinicVatRate() ?? 0;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    treatmentsApi
      .list({ status: 'active' })
      .then(setTreatments)
      .catch(() => setTreatments([]));
  }, []);

  const net = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
  const tax = items.reduce((s, it) => s + lineTax(it, vatRate), 0);
  const total = net + tax;

  const setItem = (key: number, patch: Partial<DraftItem>) =>
    setItems((arr) => arr.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  /**
   * A service added twice is the same line counted twice — reception adds two
   * X-rays by tapping the same row again, and expects a quantity of 2 rather
   * than a second identical line to reconcile later.
   */
  const addService = (t: Treatment) =>
    setItems((arr) => {
      const at = arr.findIndex((it) => it.treatmentId === t.id && it.unitPrice === t.price);
      if (at >= 0) {
        return arr.map((it, i) => (i === at ? { ...it, quantity: it.quantity + 1 } : it));
      }
      return [
        ...arr,
        {
          key: Date.now() + arr.length,
          treatmentId: t.id,
          description: t.name,
          quantity: 1,
          unitPrice: t.price,
          vatCategory: t.vatCategory,
        },
      ];
    });

  const addCustom = () =>
    setItems((arr) => [
      ...arr,
      { key: Date.now() + arr.length, description: '', quantity: 1, unitPrice: 0, vatCategory: 'medical' },
    ]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!patientId) {
      setError('Choose a patient');
      return;
    }
    if (items.length === 0) {
      setError('Add at least one service');
      return;
    }
    if (items.some((it) => !it.description.trim())) {
      setError('Every line needs a description');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const created = await financeApi.createInvoice({
        patientId,
        items: items.map(({ key: _k, ...rest }) => ({
          ...rest,
          description: rest.description.trim(),
        })),
      });
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the invoice.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title="New invoice"
      subtitle="Choose what was done from the clinic's services, or add a custom line."
      onClose={onClose}
    >
      <form className="modal__body" onSubmit={submit}>
        <PatientPicker
          value={patientName}
          onPick={(p) => {
            setPatientId(p.id);
            setPatientName(`${p.firstName} ${p.lastName}`);
          }}
          onClear={() => {
            setPatientId('');
            setPatientName('');
          }}
        />

        <ServicePicker treatments={treatments} onAdd={addService} onAddCustom={addCustom} />

        <div className="lineitems">
          <p className="lineitems__title">On this invoice</p>
          {items.length === 0 && <p className="muted">Choose the services that were done.</p>}
          {items.map((it) => (
            <div className="lineitem" key={it.key}>
              <input
                value={it.description}
                onChange={(e) => setItem(it.key, { description: e.target.value })}
                placeholder="Description"
                aria-label="Description"
              />
              <input
                type="number"
                min={1}
                value={it.quantity}
                title="Quantity"
                aria-label={`Quantity of ${it.description || 'this line'}`}
                onChange={(e) =>
                  setItem(it.key, { quantity: Math.max(1, Number(e.target.value)) })
                }
              />
              <MoneyInput
                value={it.unitPrice}
                title={`Unit price (${currencySymbol()})`}
                placeholder="0.00"
                onChange={(v) => setItem(it.key, { unitPrice: v ?? 0 })}
              />
              <span className="lineitem__amount">
                {formatMoney(it.quantity * it.unitPrice + lineTax(it, vatRate))}
              </span>
              <button
                type="button"
                className="note__del"
                title="Remove line"
                aria-label={`Remove ${it.description || 'this line'}`}
                onClick={() => setItems((arr) => arr.filter((x) => x.key !== it.key))}
              >
                <Trash2 size={13} />
              </button>
              <div className="lineitem__vat">
                <select
                  value={it.vatCategory}
                  onChange={(e) => setItem(it.key, { vatCategory: e.target.value as VatCategory })}
                  aria-label="TVSH category"
                >
                  {VAT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{vatCategoryLabel(c, vatRate)}</option>
                  ))}
                </select>
                {lineTax(it, vatRate) > 0 && <span>TVSH {formatMoney(lineTax(it, vatRate))}</span>}
              </div>
            </div>
          ))}
        </div>

        {tax > 0 && (
          <div className="invoice-total invoice-total--sub">
            <span>Before TVSH {formatMoney(net)} · TVSH {formatMoney(tax)}</span>
          </div>
        )}
        <div className="invoice-total">
          <span>Total{tax > 0 ? ' incl. TVSH' : ''}</span>
          <strong>{formatMoney(total)}</strong>
        </div>

        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create invoice'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
