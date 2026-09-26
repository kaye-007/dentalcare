import { useEffect, useState, type FormEvent } from 'react';
import QrCode from '../components/QrCode';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, Wallet, Undo2, FileDown, Landmark, RefreshCw, Printer, MessageCircle } from 'lucide-react';
import { formatRate, vatSummary } from '@dentalcare/shared';
import {
  financeApi,
  fiscalApi,
  settingsApi,
  ApiError,
  newIdempotencyKey,
  type ClinicPaymentMethod,
  type FiscalRecord,
  type InvoiceDetail,
  type InvoiceDocumentKind,
  type InvoicePayment,
  type PaymentMethod,
} from '../lib/api';
import { StatusPill, Modal, Avatar } from '../components/ui';
import VoidModal, { VoidedNote } from '../components/VoidModal';
import { useAuth } from '../lib/auth';
import { announceDrawerChange } from '../lib/features';
import { currencySymbol, formatMoney, plural, toDate } from '../lib/format';
import MoneyInput from '../components/MoneyInput';
import { dateLocale } from '../lib/strings';

function fmtDate(s: string) {
  return toDate(s).toLocaleDateString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
function fmtDateTime(s: string) {
  return new Date(s).toLocaleString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  bank: 'Bank',
};

const methodName = (p: { method: PaymentMethod; methodLabel?: string | null }) =>
  p.methodLabel ?? METHOD_LABEL[p.method];

/** Open a PDF Blob in a new tab; the object URL is released once the tab has it. */
async function openPdf(invoiceId: string) {
  const blob = await financeApi.invoicePdf(invoiceId);
  const url = URL.createObjectURL(blob);
  const tab = window.open(url, '_blank', 'noopener');
  if (!tab) {
    // A blocked pop-up: fall back to a download.
    const a = document.createElement('a');
    a.href = url;
    a.download = `invoice-${invoiceId}.pdf`;
    a.click();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [inv, setInv] = useState<InvoiceDetail | null>(null);
  const [fiscal, setFiscal] = useState<FiscalRecord | null>(null);
  const [fiscalEnabled, setFiscalEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [confirmFiscal, setConfirmFiscal] = useState(false);
  const [voiding, setVoiding] = useState<InvoicePayment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'pdf' | 'fiscal' | null>(null);
  const { can, readOnly } = useAuth();

  async function load() {
    if (!id) return;
    const [invoice, record] = await Promise.all([
      financeApi.getInvoice(id),
      fiscalApi.forInvoice(id).catch(() => null),
    ]);
    setInv(invoice);
    setFiscal(record);
  }
  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
    fiscalApi
      .settings()
      .then((s) => setFiscalEnabled(s.enabled))
      .catch(() => setFiscalEnabled(false));
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

  async function pdf() {
    if (!inv) return;
    setError(null);
    setBusy('pdf');
    try {
      await openPdf(inv.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not prepare the PDF.');
    } finally {
      setBusy(null);
    }
  }

  async function fiscalize() {
    if (!inv) return;
    setError(null);
    setBusy('fiscal');
    try {
      setFiscal(await fiscalApi.fiscalize(inv.id));
      setConfirmFiscal(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not register the invoice.');
      setConfirmFiscal(false);
    } finally {
      setBusy(null);
    }
  }

  if (loading)
    return (
      <div className="page">
        <p className="muted">Loading…</p>
      </div>
    );
  if (!inv)
    return (
      <div className="page">
        <p className="muted">Invoice not found.</p>
      </div>
    );

  const open = inv.status === 'unpaid' || inv.status === 'partially_paid';
  const canFiscalize =
    fiscalEnabled && !fiscal && inv.status !== 'cancelled' && can('invoices:fiscalize') && !readOnly;
  const partlyPaid = inv.status === 'partially_paid';

  return (
    <div className="page">
      <Link to="/invoices" className="back">
        <ChevronLeft size={16} /> All invoices
      </Link>

      <div className="page__head">
        <div className="page__head-main">
          <h1 className="section-title">{inv.invoiceNumber}</h1>
          <p className="page__meta">
            <Link to={`/patients/${inv.patientId}`} className="link" style={{ fontSize: 13 }}>
              {inv.patientName}
            </Link>{' '}
            · issued {fmtDate(inv.issuedAt)}
          </p>
        </div>
        <div className="page__actions">
          <StatusPill status={inv.status} label={inv.status === 'partially_paid' ? 'Partial' : undefined} />
          {/* What the clinic meant to issue, and whether the authority has it. */}
          {inv.documentKind === 'fiscal' ? (
            <StatusPill
              status={fiscal?.nivf ? 'ok' : fiscal ? 'warn' : 'danger'}
              label={fiscal?.nivf ? 'Fiscal invoice' : fiscal ? 'Fiscal · awaiting NIVF' : 'Fiscal · not registered'}
            />
          ) : (
            <StatusPill status="neutral" label="Internal receipt" />
          )}
          <button className="btn btn--ghost btn--sm" onClick={pdf} disabled={busy === 'pdf'}>
            <FileDown size={15} /> {busy === 'pdf' ? 'Preparing…' : 'PDF'}
          </button>
          {fiscal && (
            <Link className="btn btn--ghost btn--sm" to={`/invoices/${inv.id}/receipt`}>
              <Printer size={15} /> Fiscal receipt
            </Link>
          )}
          {inv.balance > 0 && inv.status !== 'cancelled' && can('reminders:send') && (
            <Link
              className="btn btn--ghost btn--sm"
              to={`/messages?patient=${inv.patientId}&purpose=unpaid_balance`}
            >
              <MessageCircle size={15} /> Balance notice
            </Link>
          )}
          {canFiscalize && (
            <button className="btn btn--ghost btn--sm" onClick={() => setConfirmFiscal(true)} disabled={partlyPaid}
              title={partlyPaid ? 'Fiscalize once fully paid, or before any payment for a bank transfer' : undefined}>
              <Landmark size={15} /> Fiscalize
            </button>
          )}
          {open && inv.paid === 0 && !fiscal && (
            <button className="btn btn--danger-ghost btn--sm" onClick={cancel}>
              Cancel invoice
            </button>
          )}
          {open && (
            <button className="btn btn--primary" onClick={() => setPaying(true)}>
              <Wallet size={15} /> Record payment
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="formerror" style={{ marginBottom: 14 }}>
          {error}
        </p>
      )}

      <div className="sumstrip">
        <div>
          <span>Total</span>
          <strong>{formatMoney(inv.total)}</strong>
        </div>
        <div>
          <span>Paid</span>
          <strong>{formatMoney(inv.paid)}</strong>
        </div>
        <div>
          <span>Balance</span>
          <strong className={inv.balance > 0 ? 'sumstrip__due' : ''}>{formatMoney(inv.balance)}</strong>
        </div>
      </div>

      {fiscal && (
        <FiscalPanel
          record={fiscal}
          busy={busy === 'fiscal'}
          onSendNow={can('invoices:fiscalize') && fiscal.status === 'pending' ? fiscalize : undefined}
        />
      )}

      <div className="grid">
        <div className="card span-8">
          <div className="card__head">
            <h2>Line items</h2>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Qty</th>
                <th>Unit price</th>
                <th>TVSH</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <span style={{ fontWeight: 600 }}>{it.description}</span>
                    {it.treatmentName && it.treatmentName !== it.description && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        {' '}
                        · {it.treatmentName}
                      </span>
                    )}
                  </td>
                  <td className="muted">{it.quantity}</td>
                  <td className="muted">{formatMoney(it.unitPrice)}</td>
                  <td className="muted">
                    {it.taxRateBp > 0 ? `${formatRate(it.taxRateBp)} · ${formatMoney(it.taxAmount)}` : 'Exempt'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(it.amount)}</td>
                </tr>
              ))}
            </tbody>
            {inv.taxAmount > 0 && (
              <tfoot>
                {vatSummary(
                  inv.items.map((it) => ({
                    taxRateBp: it.taxRateBp,
                    net: it.amount - it.taxAmount,
                    taxAmount: it.taxAmount,
                  })),
                ).map((g) => (
                  <tr key={g.taxRateBp} className="muted">
                    <td colSpan={3}>
                      {g.exempt ? 'Exempt from TVSH' : `TVSH ${formatRate(g.taxRateBp)}`} on {formatMoney(g.net)}
                    </td>
                    <td colSpan={2} style={{ textAlign: 'right' }}>
                      {g.exempt ? '—' : formatMoney(g.taxAmount)}
                    </td>
                  </tr>
                ))}
              </tfoot>
            )}
          </table>
        </div>

        <div className="card span-4">
          <div className="card__head">
            <h2>Payments</h2>
          </div>
          {inv.payments.length === 0 ? (
            <p className="pad muted" style={{ fontSize: 13 }}>
              No payments recorded yet.
            </p>
          ) : (
            <ul className="list">
              {inv.payments.map((p) => (
                <li className={`row${p.voidedAt ? ' row--voided' : ''}`} key={p.id}>
                  <span className="row__main">
                    <span className="row__title">{formatMoney(p.amount)}</span>
                    <span className="row__sub">
                      {fmtDateTime(p.paidAt)}
                      {p.recordedBy ? ` · ${p.recordedBy}` : ''}
                      {p.note ? ` · ${p.note}` : ''}
                    </span>
                    {p.voidedAt && <VoidedNote at={p.voidedAt} by={p.voidedByName} reason={p.voidReason} />}
                  </span>
                  <StatusPill status="neutral" label={methodName(p)} />
                  {!p.voidedAt && !fiscal && can('payments:void') && (
                    <button className="iconbtn" title="Void this payment" onClick={() => setVoiding(p)}>
                      <Undo2 size={14} />
                    </button>
                  )}
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
          onSaved={async () => {
            setPaying(false);
            await load();
          }}
          invoiceId={inv.id}
        />
      )}

      {confirmFiscal && (
        <Modal
          title="Issue as a fiscal invoice?"
          subtitle={`${inv.invoiceNumber} · ${formatMoney(inv.total)}`}
          onClose={() => setConfirmFiscal(false)}
        >
          <div className="modal__body">
            <p className="muted" style={{ margin: 0 }}>
              {inv.paid === 0
                ? 'Nothing has been paid, so it is registered as a non-cash invoice to be paid by bank transfer.'
                : 'It is registered with the payments recorded against it.'}{' '}
              Once registered with the tax authority it cannot be cancelled or have a payment voided — mistakes
              are corrected with a corrective invoice.
            </p>
            <div className="modal__foot">
              <div className="modal__foot-right">
                <button type="button" className="btn btn--ghost" onClick={() => setConfirmFiscal(false)} disabled={busy === 'fiscal'}>
                  Cancel
                </button>
                <button type="button" className="btn btn--primary" onClick={fiscalize} disabled={busy === 'fiscal'}>
                  {busy === 'fiscal' ? 'Registering…' : 'Register invoice'}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {voiding && (
        <VoidModal
          title="Void this payment"
          subtitle={`${formatMoney(voiding.amount)} by ${methodName(voiding)} on ${fmtDateTime(voiding.paidAt)}`}
          confirmLabel={`Void ${formatMoney(voiding.amount)}`}
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            await financeApi.voidPayment(voiding.id, reason);
            setVoiding(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

const FISCAL_STATUS: Record<FiscalRecord['status'], { pill: string; label: string }> = {
  fiscalized: { pill: 'ok', label: 'Registered' },
  pending: { pill: 'warn', label: 'Awaiting the tax authority' },
  rejected: { pill: 'danger', label: 'Refused' },
};

function FiscalPanel({
  record,
  busy,
  onSendNow,
}: {
  record: FiscalRecord;
  busy: boolean;
  onSendNow?: () => void;
}) {
  const s = FISCAL_STATUS[record.status];
  return (
    <section className="card" style={{ marginBottom: 16 }} aria-labelledby="fiscal-head">
      <div className="card__head">
        <div>
          <h2 id="fiscal-head">
            <Landmark size={16} aria-hidden /> Fiscal invoice {record.invNum}
          </h2>
          <p className="card__sub">
            {record.environment === 'test' ? 'TEST environment — not a legally valid fiscal invoice. ' : ''}
            {record.status === 'pending' && record.nextAttemptAt
              ? `Issued and valid to print; delivery is retried automatically (next attempt ${fmtDateTime(record.nextAttemptAt)}).`
              : record.status === 'rejected'
                ? 'The tax authority refused this registration. Contact support before issuing it again.'
                : `Confirmed ${record.fiscalizedAt ? fmtDateTime(record.fiscalizedAt) : ''}.`}
          </p>
        </div>
        <div className="inline-row">
          <StatusPill status={s.pill} label={s.label} />
          {onSendNow && (
            <button className="btn btn--ghost btn--sm" onClick={onSendNow} disabled={busy}>
              <RefreshCw size={14} aria-hidden /> {busy ? 'Sending…' : 'Send now'}
            </button>
          )}
        </div>
      </div>
      <div className="fiscal-panel">
        <a className="fiscal-panel__qr" href={record.qrUrl} target="_blank" rel="noreferrer" title="Verify on the tax authority's portal">
          <QrCode text={record.qrUrl} />
        </a>
        <dl className="fiscal-codes">
          <dt>NIVF</dt>
          <dd>{record.nivf ?? 'pending'}</dd>
          <dt>NSLF</dt>
          <dd>{record.nslf}</dd>
          <dt>Issued</dt>
          <dd>{record.issueDateTime.replace('T', ' ')}</dd>
          <dt>Type</dt>
          <dd>{record.typeOfInvoice === 'CASH' ? 'Cash' : 'Non-cash'}</dd>
          <dt>Business unit · register</dt>
          <dd>
            {record.businessUnitCode} · {record.tcrCode}
          </dd>
          <dt>Operator</dt>
          <dd>{record.operatorCode}</dd>
          {record.lastError && (
            <>
              <dt>Last answer</dt>
              <dd style={{ fontFamily: 'var(--font-body)', color: 'var(--danger-fg)' }}>
                {record.lastError}
                {record.lastErrorCode ? ` (code ${record.lastErrorCode})` : ''}
                {record.attempts > 1 ? ` · ${plural(record.attempts, 'attempt')}` : ''}
              </dd>
            </>
          )}
        </dl>
      </div>
    </section>
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
  const [amount, setAmount] = useState<number | null>(balance);
  const [methods, setMethods] = useState<ClinicPaymentMethod[] | null>(null);
  const [methodId, setMethodId] = useState('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [drawerIssue, setDrawerIssue] = useState(false);
  const [busy, setBusy] = useState(false);
  // One key for this payment, sent again on every retry of it: a double tap
  // or a lost response on a weak signal cannot take the money twice.
  const [idempotencyKey] = useState(newIdempotencyKey);
  // Which document this payment issues. Null until the clinic's settings say
  // what to preselect — `ask` leaves it null, so the choice is deliberate.
  const [docKind, setDocKind] = useState<InvoiceDocumentKind | null>(null);
  const [internalAllowed, setInternalAllowed] = useState(true);

  useEffect(() => {
    settingsApi
      .get()
      .then((s) => {
        const active = s.paymentMethods.filter((m) => m.active);
        setMethods(active);
        if (active[0]) setMethodId(active[0].id);
        setInternalAllowed(s.internalReceiptsEnabled);
        if (s.defaultCheckoutMode !== 'ask') setDocKind(s.defaultCheckoutMode);
      })
      .catch(() => setMethods(null));
  }, []);

  const options: ClinicPaymentMethod[] = methods ?? [
    { id: 'cash', label: 'Cash', kind: 'cash', active: true },
    { id: 'card', label: 'Card', kind: 'card', active: true },
    { id: 'bank', label: 'Bank transfer', kind: 'bank', active: true },
  ];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!amount) {
      setError('Enter the amount received.');
      return;
    }
    if (amount > balance) {
      setError(`That is more than the ${formatMoney(balance)} outstanding.`);
      return;
    }
    if (!docKind) {
      setError('Choose which document this payment issues.');
      return;
    }
    setError(null);
    setDrawerIssue(false);
    setBusy(true);
    try {
      const out = await financeApi.recordPayment(
        invoiceId,
        {
          amount,
          methodId,
          note: note.trim() || undefined,
          document: docKind,
        },
        idempotencyKey,
      );
      announceDrawerChange();
      // The money is recorded either way. A fiscal invoice the authority has
      // not taken yet is not an error to hide behind a closed dialog.
      if (out.fiscalError) {
        setError(`Payment recorded. ${out.fiscalError} It is in the fiscal queue.`);
        setBusy(false);
        onSaved();
        return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record payment.');
      setDrawerIssue(err instanceof ApiError && (err.code === 'drawer_not_open' || err.code === 'drawer_counting'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Record payment" subtitle={`Outstanding balance: ${formatMoney(balance)}`} onClose={onClose}>
      <form className="modal__body" onSubmit={submit}>
        <div className="grid2">
          <label className="field">
            <span>Amount ({currencySymbol()})</span>
            <MoneyInput value={amount} onChange={setAmount} placeholder="0.00" required />
          </label>
          <label className="field">
            <span>Method</span>
            <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="docswitch">
          <legend>What this payment issues</legend>
          <label className={`docswitch__opt${docKind === 'fiscal' ? ' is-picked' : ''}`}>
            <input
              type="radio"
              name="document"
              value="fiscal"
              checked={docKind === 'fiscal'}
              onChange={() => setDocKind('fiscal')}
            />
            <span className="docswitch__text">
              <strong>Faturë e fiskalizuar</strong>
              <span className="small muted">
                Official fiscal invoice. Registered with the tax authority, which returns the NIVF; the receipt
                carries the NSLF and the QR code.
              </span>
            </span>
          </label>
          <label
            className={`docswitch__opt${docKind === 'internal' ? ' is-picked' : ''}${internalAllowed ? '' : ' is-off'}`}
          >
            <input
              type="radio"
              name="document"
              value="internal"
              disabled={!internalAllowed}
              checked={docKind === 'internal'}
              onChange={() => setDocKind('internal')}
            />
            <span className="docswitch__text">
              <strong>Faturë fiktive</strong>
              <span className="small muted">
                {internalAllowed
                  ? 'Internal receipt on the clinic’s own letterhead. Nothing is sent to the tax authority, and it is not a tax invoice.'
                  : 'Turned off for this clinic: every payment is fiscalized.'}
              </span>
            </span>
          </label>
        </fieldset>
        <label className="field">
          <span>Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" maxLength={300} />
        </label>
        {error && (
          <p className="formerror">
            {error}{' '}
            {drawerIssue && (
              <Link to="/drawer" className="table__link">
                Go to the cash drawer
              </Link>
            )}
          </p>
        )}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={busy || !docKind}>
              {busy
                ? 'Saving…'
                : docKind === 'fiscal'
                  ? `Record ${formatMoney(amount || 0)} and fiscalize`
                  : `Record ${formatMoney(amount || 0)}`}
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
  const [voiding, setVoiding] = useState<import('../lib/api').PaymentHistoryRow | null>(null);
  const { can } = useAuth();

  async function load() {
    setItems(await financeApi.listPayments());
  }
  useEffect(() => {
    void load();
  }, []);

  // Voided payments stay in the list, struck through — but they are not money
  // the clinic holds, so they must not be in the total.
  const live = (items ?? []).filter((p) => !p.voidedAt);
  const total = live.reduce((s, p) => s + p.amount, 0);
  const voidedCount = (items ?? []).length - live.length;
  return (
    <div className="page">
      <div className="page__head">
        <div className="page__head-main">
          <h1 className="section-title">Payments</h1>
          <p className="page__meta">
            {items
              ? `${plural(live.length, 'payment')} · ${formatMoney(total)} collected${voidedCount ? ` · ${voidedCount} voided` : ''}`
              : '…'}
          </p>
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
              <tr>
                <th>Date</th>
                <th>Invoice</th>
                <th>Patient</th>
                <th>Method</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                {can('payments:void') && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} className={p.voidedAt ? 'tr--voided' : undefined}>
                  <td className="muted">{fmtDateTime(p.paidAt)}</td>
                  <td>
                    <Link to={`/invoices/${p.invoiceId}`} className="link">
                      {p.invoiceNumber}
                    </Link>
                  </td>
                  <td>
                    <div className="namecell">
                      <Avatar name={p.patientName} size={26} />
                      <span>{p.patientName}</span>
                    </div>
                    {p.voidedAt && <VoidedNote at={p.voidedAt} by={p.voidedByName} reason={p.voidReason} />}
                  </td>
                  <td>
                    <StatusPill status="neutral" label={methodName(p)} />
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(p.amount)}</td>
                  {can('payments:void') && (
                    <td style={{ textAlign: 'right' }}>
                      {!p.voidedAt && (
                        <button className="iconbtn" title="Void this payment" onClick={() => setVoiding(p)}>
                          <Undo2 size={14} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {voiding && (
        <VoidModal
          title="Void this payment"
          subtitle={`${formatMoney(voiding.amount)} from ${voiding.patientName} on ${voiding.invoiceNumber}`}
          confirmLabel={`Void ${formatMoney(voiding.amount)}`}
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            await financeApi.voidPayment(voiding.id, reason);
            setVoiding(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
