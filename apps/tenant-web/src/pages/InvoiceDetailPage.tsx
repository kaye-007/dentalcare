import { useEffect, useRef, useState, type FormEvent } from 'react';
import QrCode from '../components/QrCode';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { Check, ChevronLeft, Wallet, Undo2, FileDown, Landmark, MessageCircle, RefreshCw, Printer, XCircle } from 'lucide-react';
import { formatRate, vatSummary } from '@dentalcare/shared';
import {
  drawerApi,
  financeApi,
  fiscalApi,
  settingsApi,
  ApiError,
  humanError,
  newIdempotencyKey,
  type CheckoutResult,
  type ClinicPaymentMethod,
  type DrawerCurrent,
  type FiscalRecord,
  type InvoiceDetail,
  type InvoiceDocumentKind,
  type InvoicePayment,
  type PaymentMethod,
} from '../lib/api';
import {
  Avatar,
  Disclosure,
  EmptyState,
  ErrorState,
  LoadingRows,
  Modal,
  MoreMenu,
  PageLoading,
  Segmented,
  StatusPill,
  useToast,
} from '../components/ui';
import VoidModal, { VoidedNote } from '../components/VoidModal';
import { useAuth } from '../lib/auth';
import { useMessaging } from '../lib/messaging';
import { announceDrawerChange } from '../lib/features';
import { currencySymbol, formatMoney, plural, symbolAfter, toDate } from '../lib/format';
import MoneyInput from '../components/MoneyInput';
import { dateLocale } from '../lib/strings';
import { StartDay } from './CashDrawerPage';

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
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [voiding, setVoiding] = useState<InvoicePayment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'pdf' | 'fiscal' | null>(null);
  const { can, readOnly } = useAuth();
  const openMessage = useMessaging();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const payRequested = searchParams.get('pay') === '1';

  async function load() {
    if (!id) return;
    const [invoice, record] = await Promise.all([
      financeApi.getInvoice(id),
      fiscalApi.forInvoice(id).catch(() => null),
    ]);
    setInv(invoice);
    setFiscal(record);
  }
  // "Payment" on the patient record lands here with the sheet already open.
  useEffect(() => {
    if (!payRequested || !inv) return;
    if (inv.status === 'unpaid' || inv.status === 'partially_paid') setPaying(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('pay');
        return next;
      },
      { replace: true },
    );
  }, [payRequested, inv, setSearchParams]);

  useEffect(() => {
    setLoading(true);
    load()
      .catch(() => setInv(null))
      .finally(() => setLoading(false));
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
      toast(`${inv.invoiceNumber} cancelled.`);
      await load();
    } catch (err) {
      setError(humanError(err, 'The invoice could not be cancelled.'));
    }
  }

  async function pdf() {
    if (!inv) return;
    setError(null);
    setBusy('pdf');
    try {
      await openPdf(inv.id);
    } catch (err) {
      setError(humanError(err, 'The PDF could not be prepared.'));
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
      setError(humanError(err, 'The invoice could not be registered with the tax authority.'));
      setConfirmFiscal(false);
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <PageLoading label="Loading the invoice" />;
  if (!inv)
    return (
      <div className="page">
        <Link to="/invoices" className="back">
          <ChevronLeft size={16} aria-hidden /> All invoices
        </Link>
        <EmptyState
          framed
          icon={<XCircle size={22} />}
          title="Invoice not found"
          body="It may have been removed, or the link is incomplete."
        />
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
            <StatusPill {...fiscalState(fiscal)} />
          ) : (
            <StatusPill status="neutral" label="Internal receipt" />
          )}
          {/* Everything but taking money is one click further in. */}
          <MoreMenu
            label="More invoice actions"
            items={[
              {
                label: busy === 'pdf' ? 'Preparing PDF…' : 'Download PDF',
                icon: <FileDown size={15} aria-hidden />,
                onSelect: () => void pdf(),
              },
              ...(fiscal
                ? [
                    {
                      label: 'Print fiscal receipt',
                      icon: <Printer size={15} aria-hidden />,
                      onSelect: () => window.open(`/invoices/${inv.id}/receipt`, '_self'),
                    },
                  ]
                : []),
              ...(canFiscalize && !partlyPaid
                ? [
                    {
                      label: 'Issue as fiscal invoice…',
                      icon: <Landmark size={15} aria-hidden />,
                      onSelect: () => setConfirmFiscal(true),
                    },
                  ]
                : []),
              // What is owed on this invoice, asked for politely, from the desk's WhatsApp.
              ...(open && inv.balance > 0 && can('reminders:send') && !readOnly
                ? [
                    {
                      label: 'Remind about the balance',
                      icon: <MessageCircle size={15} aria-hidden />,
                      onSelect: () =>
                        openMessage({
                          patientId: inv.patientId,
                          patientName: inv.patientName,
                          purpose: 'unpaid_balance',
                          invoiceId: inv.id,
                        }),
                    },
                  ]
                : []),
              ...(open && inv.paid === 0 && !fiscal && can('invoices:write') && !readOnly
                ? [
                    {
                      label: 'Cancel invoice…',
                      icon: <XCircle size={15} aria-hidden />,
                      danger: true,
                      onSelect: () => setConfirmCancel(true),
                    },
                  ]
                : []),
            ]}
          />
          {open && can('payments:write') && !readOnly && (
            <button className="btn btn--primary" onClick={() => setPaying(true)}>
              <Wallet size={15} aria-hidden /> Pay
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
                <th className="hide-sm">Unit price</th>
                <th className="hide-sm">TVSH</th>
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
                  <td className="muted hide-sm">{formatMoney(it.unitPrice)}</td>
                  <td className="muted hide-sm">
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
                    <button
                      className="iconbtn iconbtn--quiet"
                      title="Void this payment"
                      aria-label={`Void the ${formatMoney(p.amount)} payment`}
                      onClick={() => setVoiding(p)}
                    >
                      <Undo2 size={14} aria-hidden />
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
          lastPaid={
            inv.payments
              .filter((p) => !p.voidedAt)
              .sort((a, b) => b.paidAt.localeCompare(a.paidAt))[0] ?? null
          }
          patientName={inv.patientName}
          invoiceNumber={inv.invoiceNumber}
          onClose={() => setPaying(false)}
          onSaved={() => void load()}
          onPdf={() => void pdf()}
          invoiceId={inv.id}
        />
      )}

      {confirmCancel && (
        <Modal
          title={`Cancel ${inv.invoiceNumber}?`}
          subtitle={`${inv.patientName} · ${formatMoney(inv.total)}`}
          onClose={() => setConfirmCancel(false)}
        >
          <div className="modal__body">
            <p className="modal__text">
              Nothing has been paid on it. The invoice stays in the list, marked cancelled, so the numbering
              has no gaps.
            </p>
            <div className="modal__foot">
              <div className="modal__foot-right">
                <button type="button" className="btn btn--ghost" onClick={() => setConfirmCancel(false)}>
                  Keep it
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    setConfirmCancel(false);
                    void cancel();
                  }}
                >
                  Cancel invoice
                </button>
              </div>
            </div>
          </div>
        </Modal>
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
            toast('Payment voided.');
            await load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Fiscalization in the three words the desk needs. The identifiers behind
 * them (NIVF, NSLF, TCR…) are for an accountant or an inspector, and sit
 * under "Fiscal details".
 */
function fiscalState(record: FiscalRecord | null): { status: string; label: string } {
  if (record?.status === 'fiscalized' && record.nivf) return { status: 'ok', label: 'Fiscalized' };
  if (record?.status === 'pending') return { status: 'warn', label: 'Fiscalization pending' };
  return { status: 'danger', label: 'Fiscalization needs attention' };
}

function FiscalPanel({
  record,
  busy,
  onSendNow,
}: {
  record: FiscalRecord;
  busy: boolean;
  onSendNow?: () => void;
}) {
  const s = fiscalState(record);
  return (
    <section className="card" style={{ marginBottom: 16 }} aria-labelledby="fiscal-head">
      <div className="card__head">
        <div>
          <h2 id="fiscal-head">
            <Landmark size={16} aria-hidden /> Fiscal invoice {record.invNum}
          </h2>
          <p className="card__sub">
            {record.environment === 'test' ? 'TEST environment — not a legally valid fiscal invoice. ' : ''}
            {record.status === 'pending'
              ? 'Valid to print now. DentalCare keeps sending it to the tax authority until it is confirmed.'
              : record.status === 'rejected'
                ? 'The tax authority refused this invoice. Contact support before issuing it again.'
                : `Confirmed by the tax authority${record.fiscalizedAt ? ` on ${fmtDateTime(record.fiscalizedAt)}` : ''}.`}
          </p>
        </div>
        <div className="inline-row">
          <StatusPill status={s.status} label={s.label} />
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
        <Disclosure summary="Fiscal details" hint="NIVF, NSLF, register">
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
          {record.status === 'pending' && record.nextAttemptAt && (
            <>
              <dt>Next attempt</dt>
              <dd>{fmtDateTime(record.nextAttemptAt)}</dd>
            </>
          )}
        </dl>
        </Disclosure>
      </div>
    </section>
  );
}

/** The method's icon-free, one-word name for the segmented control. */
const shortMethod = (m: ClinicPaymentMethod) => (m.label.length > 14 ? m.label.slice(0, 13) + '…' : m.label);

/**
 * Taking a payment: the amount, how it was paid, one button. Which document
 * it issues is the clinic's default and only shown when there is a choice to
 * make; a note is one click away. After it goes through, the sheet turns into
 * the receipt of what happened — amount, method, what is still owed — so no
 * one has to leave the page to know it worked.
 *
 * The method starts on the one this bill was last paid with, while the
 * clinic still offers it: instalments are usually paid the same way. A
 * first payment starts on the clinic's first method. Either way the choice
 * is on screen, large, before anything is taken.
 */
function PaymentModal({
  invoiceId,
  balance,
  lastPaid,
  patientName,
  invoiceNumber,
  onClose,
  onSaved,
  onPdf,
}: {
  invoiceId: string;
  balance: number;
  lastPaid: Pick<InvoicePayment, 'method' | 'methodLabel'> | null;
  patientName: string;
  invoiceNumber: string;
  onClose: () => void;
  onSaved: () => void;
  onPdf: () => void;
}) {
  const [amount, setAmount] = useState<number | null>(balance);
  const [methods, setMethods] = useState<ClinicPaymentMethod[] | null>(null);
  // The fallback methods' ids are their kinds, so this holds until settings load.
  const [methodId, setMethodId] = useState<string>(lastPaid?.method ?? 'cash');
  // Read once, when the sheet opens; the settings below arrive after.
  const lastPaidRef = useRef(lastPaid);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [drawerIssue, setDrawerIssue] = useState(false);
  // Cash with the drawer closed: start the day right here, then take the payment.
  const [closedDrawer, setClosedDrawer] = useState<DrawerCurrent | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CheckoutResult | null>(null);
  // One key for this payment, sent again on every retry of it: a double tap
  // or a lost response on a weak signal cannot take the money twice.
  const [idempotencyKey] = useState(newIdempotencyKey);
  // Which document this payment issues. Null until the clinic's settings say
  // what to preselect — `ask` leaves it null, so the choice is deliberate.
  const [docKind, setDocKind] = useState<InvoiceDocumentKind | null>(null);
  const [askDoc, setAskDoc] = useState(true);
  const [internalAllowed, setInternalAllowed] = useState(true);
  // Until fiscalization is set up (server code + clinic switched on), every
  // payment issues an internal receipt — faturë fiktive — and the fiscal
  // choice is not offered.
  const [fiscalReady, setFiscalReady] = useState(true);
  const fiscalReadyRef = useRef(true);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    settingsApi
      .get()
      .then((s) => {
        const active = s.paymentMethods.filter((m) => m.active);
        setMethods(active);
        const last = lastPaidRef.current;
        const same =
          last &&
          (active.find((m) => last.methodLabel !== null && m.label === last.methodLabel) ??
            active.find((m) => m.kind === last.method));
        const start = same ?? active[0];
        if (start) setMethodId(start.id);
        setInternalAllowed(s.internalReceiptsEnabled);
        if (s.defaultCheckoutMode !== 'ask' && fiscalReadyRef.current) {
          setDocKind(s.defaultCheckoutMode);
          setAskDoc(false);
        }
      })
      .catch(() => setMethods(null));
    fiscalApi
      .settings()
      .then((f) => {
        const ready = f.enabled && (f as { available?: boolean }).available !== false;
        setFiscalReady(ready);
        fiscalReadyRef.current = ready;
        if (!ready) {
          setDocKind('internal');
          setAskDoc(false);
        }
      })
      .catch(() => {
        setFiscalReady(false);
        fiscalReadyRef.current = false;
        setDocKind('internal');
        setAskDoc(false);
      });
  }, []);

  const options: ClinicPaymentMethod[] = methods ?? [
    { id: 'cash', label: 'Cash', kind: 'cash', active: true },
    { id: 'card', label: 'Card', kind: 'card', active: true },
    { id: 'bank', label: 'Bank transfer', kind: 'bank', active: true },
  ];
  const method = options.find((m) => m.id === methodId);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!amount) {
      setError('Enter the amount received.');
      amountRef.current?.focus();
      return;
    }
    if (amount > balance) {
      setError(`That is more than the ${formatMoney(balance)} still owed.`);
      amountRef.current?.focus();
      return;
    }
    if (!docKind) {
      setError('Choose which document this payment issues.');
      return;
    }
    setError(null);
    setDrawerIssue(false);
    setClosedDrawer(null);
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
      // The money is recorded either way; the page behind catches up now.
      setDone(out);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'drawer_not_open') {
        // Not an error to send someone away for: offer to start the day here.
        const current = await drawerApi.current().catch(() => null);
        if (current && !current.session) {
          setClosedDrawer(current);
          return;
        }
      }
      setError(humanError(err, 'The payment could not be recorded. Nothing was taken — try again.'));
      setDrawerIssue(err instanceof ApiError && (err.code === 'drawer_not_open' || err.code === 'drawer_counting'));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const paid = amount ?? 0;
    return (
      <Modal title="Paid" subtitle={`${patientName} · ${invoiceNumber}`} onClose={onClose}>
        <div className="modal__body paydone">
          <span className="paydone__check" aria-hidden>
            <Check size={28} strokeWidth={2.4} />
          </span>
          <p className="paydone__amount">{formatMoney(paid)}</p>
          <p className="paydone__method">
            {method?.label ?? 'Payment'} ·{' '}
            {docKind !== 'fiscal'
              ? 'internal receipt'
              : done.fiscal?.status === 'fiscalized'
                ? '✓ Fiscalized'
                : 'Fiscalization pending'}
          </p>
          <p className={`paydone__left${done.balance > 0 ? ' paydone__left--owing' : ''}`}>
            {done.balance > 0 ? `${formatMoney(done.balance)} still to pay` : 'Paid in full'}
          </p>
          {done.fiscalError && (
            <p className="formwarn" role="status">
              <span>
                The payment is recorded. {done.fiscalError} The invoice is in the fiscal queue and will be sent
                again automatically.
              </span>
            </p>
          )}
          <div className="modal__foot">
            {done.fiscal ? (
              <Link className="btn btn--ghost" to={`/invoices/${invoiceId}/receipt`}>
                <Printer size={15} aria-hidden /> Print receipt
              </Link>
            ) : (
              <button type="button" className="btn btn--ghost" onClick={onPdf}>
                <FileDown size={15} aria-hidden /> Receipt PDF
              </button>
            )}
            <div className="modal__foot-right">
              <button type="button" className="btn btn--primary" onClick={onClose} autoFocus>
                Done
              </button>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  const docLabel = docKind === 'fiscal' ? 'Fiscal invoice (faturë e fiskalizuar)' : 'Internal receipt (faturë fiktive)';

  return (
    <Modal title="Payment" subtitle={`${patientName} · ${formatMoney(balance)} owed`} onClose={onClose}>
      <form className="modal__body paysheet" onSubmit={submit} noValidate>
        <label className="paysheet__amount">
          <span className="sr-only">Amount received ({currencySymbol()})</span>
          {!symbolAfter() && (
            <span className="paysheet__currency" aria-hidden>
              {currencySymbol()}
            </span>
          )}
          <MoneyInput
            ref={amountRef}
            value={amount}
            onChange={(v) => {
              setAmount(v);
              if (error) setError(null);
            }}
            placeholder="0"
            aria-invalid={Boolean(error && (!amount || amount > balance))}
            autoFocus
          />
          {symbolAfter() && (
            <span className="paysheet__currency" aria-hidden>
              {currencySymbol()}
            </span>
          )}
        </label>
        {amount !== null && amount > 0 && amount < balance && (
          <p className="paysheet__hint">
            Part payment · {formatMoney(balance - amount)} will remain.{' '}
            <button type="button" className="linkbtn" onClick={() => setAmount(balance)}>
              Pay all {formatMoney(balance)}
            </button>
          </p>
        )}

        {options.length <= 4 ? (
          <Segmented
            size="lg"
            label="Payment method"
            value={methodId}
            onChange={setMethodId}
            options={options.map((m) => ({ value: m.id, label: shortMethod(m) }))}
          />
        ) : (
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
        )}

        {askDoc ? (
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
                <strong>Fiscal invoice</strong>
                <span className="small muted">Registered with the tax authority (faturë e fiskalizuar).</span>
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
                <strong>Internal receipt</strong>
                <span className="small muted">
                  {internalAllowed
                    ? 'On the clinic’s letterhead; not sent to the tax authority.'
                    : 'Turned off for this clinic: every payment is fiscalized.'}
                </span>
              </span>
            </label>
          </fieldset>
        ) : (
          <p className="paysheet__doc">
            Issues {/^[aeiou]/i.test(docLabel) ? 'an' : 'a'} {docLabel.split(' (')[0]!.toLowerCase()}.{' '}
            {internalAllowed && fiscalReady && (
              <button type="button" className="linkbtn" onClick={() => setAskDoc(true)}>
                Change
              </button>
            )}
          </p>
        )}

        <Disclosure summary="Add a note" hint={note ? note : undefined}>
          <label className="field">
            <span className="sr-only">Note</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" maxLength={300} />
          </label>
        </Disclosure>

        {closedDrawer && (
          <div className="channel-note">
            <StartDay
              current={closedDrawer}
              submitLabel="Start drawer"
              onStarted={() => {
                setClosedDrawer(null);
                announceDrawerChange();
                // Same idempotency key: the refused attempt released it.
                void submit();
              }}
            />
          </div>
        )}
        {error && (
          <p className="formerror" role="alert">
            {error}{' '}
            {drawerIssue && (
              <Link to="/drawer" className="table__link">
                Go to the cash drawer
              </Link>
            )}
          </p>
        )}
        <button className="btn btn--primary paysheet__go" disabled={busy || !docKind}>
          {busy ? 'Paying…' : `Pay ${formatMoney(amount || 0)}`}
        </button>
      </form>
    </Modal>
  );
}

/* ════════ Payments history page ════════ */
export function PaymentsPage() {
  const [items, setItems] = useState<import('../lib/api').PaymentHistoryRow[] | null>(null);
  const [voiding, setVoiding] = useState<import('../lib/api').PaymentHistoryRow | null>(null);
  const { can } = useAuth();

  const [loadError, setLoadError] = useState<string | null>(null);
  async function load() {
    setLoadError(null);
    try {
      setItems(await financeApi.listPayments());
    } catch (err) {
      setLoadError(humanError(err, 'Payments could not be loaded.'));
    }
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
        {loadError ? (
          <ErrorState body={loadError} onRetry={() => void load()} />
        ) : items === null ? (
          <LoadingRows rows={6} avatar label="Loading payments" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Wallet size={22} />}
            title="No payments yet"
            body="Payments appear here as they are taken from an invoice."
            action={
              <Link to="/invoices" className="btn btn--ghost btn--sm">
                Go to invoices
              </Link>
            }
          />
        ) : (
          <table className="table table--money">
            <thead>
              <tr>
                <th>Date</th>
                <th className="hide-sm hide-md">Invoice</th>
                <th>Patient</th>
                <th className="hide-sm">Method</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                {can('payments:void') && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} className={p.voidedAt ? 'tr--voided' : undefined}>
                  <td className="muted">{fmtDateTime(p.paidAt)}</td>
                  <td className="hide-sm hide-md">
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
                  <td className="hide-sm">
                    <StatusPill status="neutral" label={methodName(p)} />
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {formatMoney(p.amount)}
                    {/* On a phone the method rides under the amount. */}
                    <span className="cell-sub only-sm">{methodName(p)}</span>
                  </td>
                  {can('payments:void') && (
                    <td style={{ textAlign: 'right' }}>
                      {!p.voidedAt && (
                        <button
                          className="iconbtn iconbtn--quiet"
                          title="Void this payment"
                          aria-label={`Void the ${formatMoney(p.amount)} payment from ${p.patientName}`}
                          onClick={() => setVoiding(p)}
                        >
                          <Undo2 size={14} aria-hidden />
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
