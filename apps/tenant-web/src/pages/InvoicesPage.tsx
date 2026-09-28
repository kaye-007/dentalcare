import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Search, ReceiptText, Trash2, Stethoscope } from 'lucide-react';
import ServicePicker from '../components/ServicePicker';
import {
  financeApi,
  treatmentsApi,
  ApiError,
  type InvoiceSummaryRow,
  type LineItemPayload,
  type Treatment,
  newIdempotencyKey,
} from '../lib/api';
import {
  PageHeader,
  StatusPill,
  EmptyState,
  Modal,
  Avatar,
  LoadingRows,
  Disclosure,
} from '../components/ui';
import PatientPicker from '../components/PatientPicker';
import { useAuth } from '../lib/auth';
import { currencySymbol, formatMoney, toDate } from '../lib/format';
import MoneyInput from '../components/MoneyInput';
import { dateLocale, t, type StringKey } from '../lib/strings';
import {
  VAT_CATEGORIES,
  vatCategoryLabel,
  vatRateFor,
  type VatCategory,
} from '@dentalcare/shared';
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
  const { readOnly, can } = useAuth();
  const [status, setStatus] = useState<string>('all');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState<InvoiceSummaryRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  // A bill started from a visit ("Bill" on the dashboard) arrives with its patient.
  const [forPatient, setForPatient] = useState<{ id: string; name: string } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // "New invoice" from the topbar menu lands here with ?new=1. Open the form
  // once, then drop the flag so a reload does not open it again.
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    const pid = searchParams.get('patient');
    setForPatient(pid ? { id: pid, name: searchParams.get('name') ?? '' } : null);
    setCreating(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('new');
        next.delete('patient');
        next.delete('name');
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

  // The clinic's outstanding, from the server — not the sum of the rows that
  // happen to be loaded, which read as the whole clinic's figure but were not.
  const [outstanding, setOutstanding] = useState<number | null>(null);
  useEffect(() => {
    financeApi
      .summary('month')
      .then((s) => setOutstanding(s.outstanding))
      .catch(() => setOutstanding(null));
  }, []);

  return (
    <div className="page">
      <PageHeader
        title="Invoices"
        meta={
          outstanding === null
            ? undefined
            : outstanding > 0
              ? `${formatMoney(outstanding)} outstanding across the clinic`
              : 'Nothing outstanding'
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
          <LoadingRows rows={3} label="Loading" />
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
          <table className="table table--money">
            <thead>
              <tr>
                <th>{t('invoice.col.invoice')}</th>
                <th>{t('invoice.col.patient')}</th>
                <th className="hide-sm hide-md">{t('invoice.col.date')}</th>
                <th className="hide-sm">{t('invoice.col.total')}</th>
                <th className="hide-sm hide-md">{t('invoice.col.paid')}</th>
                <th>{t('invoice.col.balance')}</th>
                <th className="hide-sm">{t('invoice.col.status')}</th>
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
                  <td className="muted hide-sm hide-md">{fmtDate(i.issuedAt)}</td>
                  <td className="hide-sm">{formatMoney(i.total)}</td>
                  <td className="muted hide-sm hide-md">{formatMoney(i.paid)}</td>
                  <td>
                    {i.balance > 0 ? (
                      <strong className="owes">{formatMoney(i.balance)}</strong>
                    ) : (
                      <span className="muted" aria-label="Nothing owed">
                        —
                      </span>
                    )}
                    {/* On a phone the status rides under the balance. */}
                    <span className="only-sm">
                      <StatusPill
                        status={i.status}
                        label={i.status === 'partially_paid' ? 'Partial' : undefined}
                      />
                    </span>
                  </td>
                  <td className="hide-sm">
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
          initialPatient={forPatient}
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            // Straight on to taking the money: one flow, not two screens.
            navigate(can('payments:write') ? `/invoices/${id}?pay=1` : `/invoices/${id}`);
          }}
        />
      )}
    </div>
  );
}

interface DraftItem extends LineItemPayload {
  key: number;
  vatCategory: VatCategory;
  /** For a line from the chart: tooth, date and dentist, shown under it. */
  chartNote?: string;
}

/** The server's arithmetic (billing-engine calculateInvoiceLine), for the preview only. */
function lineTax(it: DraftItem, clinicRateBp: number): number {
  const rate = vatRateFor(it.vatCategory, clinicRateBp);
  return Math.round((it.quantity * it.unitPrice * rate) / 10_000);
}

function NewInvoiceModal({
  initialPatient,
  onClose,
  onCreated,
}: {
  initialPatient?: { id: string; name: string } | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  // One key for this invoice, however many times Create is pressed (0024).
  const [idemKey] = useState(newIdempotencyKey);
  const [patientId, setPatientId] = useState(initialPatient?.id ?? '');
  const [patientName, setPatientName] = useState(initialPatient?.name ?? '');
  const [treatments, setTreatments] = useState<Treatment[]>([]);
  const [items, setItems] = useState<DraftItem[]>([]);
  const vatRate = useClinicVatRate() ?? 0;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // How many lines came from the chart, for the note above them.
  const [fromChart, setFromChart] = useState(0);
  // Read when the chart's answer arrives: were lines added in the meantime?
  const itemCount = useRef(0);
  itemCount.current = items.length;

  // What the dentist charted and nobody has billed yet becomes the invoice.
  // Only onto an empty invoice: lines someone already added are theirs.
  useEffect(() => {
    setFromChart(0);
    if (!patientId) return;
    let live = true;
    financeApi
      .unbilled(patientId)
      .then((rows) => {
        if (!live || rows.length === 0 || itemCount.current > 0) return;
        setFromChart(rows.length);
        setItems(
          rows.map((r, i) => ({
            key: Date.now() + i,
            treatmentId: r.treatmentId ?? undefined,
            procedureId: r.procedureId,
            description: r.description,
            quantity: 1,
            unitPrice: r.fee,
            vatCategory: r.vatCategory,
            chartNote: [
              r.tooth ? `Tooth ${r.tooth}` : null,
              fmtDate(r.performedOn),
              r.clinicianName,
            ]
              .filter(Boolean)
              .join(' · '),
          })),
        );
      })
      // Advisory: without it, the services are picked by hand as before.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [patientId]);

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
      // A charted line is one procedure; a second one is a new line.
      const at = arr.findIndex(
        (it) => !it.procedureId && it.treatmentId === t.id && it.unitPrice === t.price,
      );
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
      {
        key: Date.now() + arr.length,
        description: '',
        quantity: 1,
        unitPrice: 0,
        vatCategory: 'medical',
      },
    ]);

  const servicePicker = (
    <ServicePicker treatments={treatments} onAdd={addService} onAddCustom={addCustom} />
  );

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
      const created = await financeApi.createInvoice(
        {
          patientId,
          items: items.map(({ key: _k, chartNote: _n, ...rest }) => ({
            ...rest,
            description: rest.description.trim(),
          })),
        },
        idemKey,
      );
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
      subtitle={
        fromChart > 0
          ? 'What the dentist charted is already on it.'
          : "Choose what was done from the clinic's services, or add a custom line."
      }
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
            // Chart lines belong to the patient they came from.
            setItems((arr) => arr.filter((it) => !it.procedureId));
          }}
        />

        {/* With the chart's lines already on it, the catalogue is the
            exception: it folds away under the lines instead of leading. */}
        {fromChart === 0 && servicePicker}

        <div className="lineitems">
          <p className="lineitems__title">On this invoice</p>
          {fromChart > 0 && items.some((it) => it.procedureId) && (
            <p className="lineitems__from-chart">
              <Stethoscope size={14} aria-hidden />
              {fromChart === 1
                ? 'The treatment charted for this patient is already here.'
                : `The ${fromChart} treatments charted for this patient are already here.`}{' '}
              Check the prices, then create the invoice.
            </p>
          )}
          {items.length === 0 && (
            <p className="muted">Choose the services that were done.</p>
          )}
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
                {it.chartNote && (
                  <span className="lineitem__chart">From the chart · {it.chartNote}</span>
                )}
                <select
                  value={it.vatCategory}
                  onChange={(e) =>
                    setItem(it.key, { vatCategory: e.target.value as VatCategory })
                  }
                  aria-label="TVSH category"
                >
                  {VAT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {vatCategoryLabel(c, vatRate)}
                    </option>
                  ))}
                </select>
                {lineTax(it, vatRate) > 0 && (
                  <span>TVSH {formatMoney(lineTax(it, vatRate))}</span>
                )}
              </div>
            </div>
          ))}
        </div>

        {fromChart > 0 && (
          <Disclosure summary="Add another service">{servicePicker}</Disclosure>
        )}

        {tax > 0 && (
          <div className="invoice-total invoice-total--sub">
            <span>
              Before TVSH {formatMoney(net)} · TVSH {formatMoney(tax)}
            </span>
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
