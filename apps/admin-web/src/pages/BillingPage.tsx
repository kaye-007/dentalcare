import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  CircleCheck,
  Coins,
  Download,
  FileClock,
  PiggyBank,
  Play,
  ReceiptText,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  ApiError,
  api,
  formatEuro,
  METHOD_LABELS,
  type BillingSummary,
  type SubscriptionInvoice,
} from '../lib/api';
import { downloadCsv, fmtDay, lastMonths, monthLabel, stamp } from '../lib/format';
import {
  ClinicMark,
  Empty,
  Kpi,
  SkeletonRows,
  useConfirm,
  useToast,
} from '../components/ui';
import PaymentModal from '../components/PaymentModal';
import { InvoiceState } from './TenantDetailPage';
import { useShell } from '../components/shell';

/**
 * Who has paid, who has not, and who is late.
 *
 * The clinic-facing app bills patients; this bills the clinics. They are
 * deliberately different screens with different vocabulary, because confusing
 * the two is how a vendor ends up chasing a patient for a subscription.
 */

type Filter = 'overdue' | 'open' | 'paid' | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'open', label: 'Open' },
  { key: 'paid', label: 'Paid' },
  { key: 'all', label: 'All' },
];

export default function BillingPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { refreshBadges } = useShell();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [all, setAll] = useState<SubscriptionInvoice[] | null>(null);
  const [filter, setFilter] = useState<Filter>('overdue');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [paying, setPaying] = useState<SubscriptionInvoice | null>(null);
  // This month or either of the two before it: a month missed while someone
  // was away can still be billed, but nothing further back by accident.
  const months = useMemo(() => lastMonths(3).reverse(), []);
  const [period, setPeriod] = useState(months[0]!);

  // Every invoice once, filtered here: the tab counts and the search both need
  // the whole set, and a fleet's subscription invoices are a small table.
  const load = useCallback(() => {
    Promise.all([api.billingSummary(), api.subscriptionInvoices({})])
      .then(([s, list]) => {
        setSummary(s);
        setAll(list);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const counts = useMemo(() => {
    const r = all ?? [];
    return {
      overdue: r.filter((i) => i.status === 'open' && i.overdue).length,
      open: r.filter((i) => i.status === 'open').length,
      paid: r.filter((i) => i.status === 'paid').length,
      all: r.length,
    } satisfies Record<Filter, number>;
  }, [all]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (all ?? []).filter(
      (i) =>
        (filter === 'all' ||
          (filter === 'overdue'
            ? i.status === 'open' && i.overdue
            : i.status === filter)) &&
        (!term ||
          i.number.toLowerCase().includes(term) ||
          i.tenantName.toLowerCase().includes(term) ||
          i.subdomain.includes(term) ||
          (i.reference ?? '').toLowerCase().includes(term)),
    );
  }, [all, filter, q]);

  async function run() {
    const label = monthLabel(period, 'long');
    if (
      !(await confirm({
        title: `Run billing for ${label}?`,
        body:
          `Issues one invoice to every active clinic with a plan that is out of trial and not yet billed for ${label}. Clinics already billed for that month are skipped, so running it twice is safe.` +
          (period === months[0]
            ? ''
            : ` Clinics are chosen by their plan and status today, and due dates count from the first of ${label} — so these invoices may be overdue as soon as they are issued.`),
        confirmLabel: 'Run billing',
        icon: Play,
        tone: 'default',
      }))
    ) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const result = await api.runBilling(`${period}-01`);
      toast(
        result.issued === 0
          ? `Nothing to issue — all ${result.considered} clinics are already billed for ${label}.`
          : `Issued ${result.issued} invoice${result.issued === 1 ? '' : 's'} for ${label}, of ${result.considered} clinics considered.`,
      );
      load();
      refreshBadges();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not run billing.');
    } finally {
      setRunning(false);
    }
  }

  function exportCsv() {
    downloadCsv(
      `subscription-invoices-${stamp()}.csv`,
      [
        'Invoice',
        'Clinic',
        'Subdomain',
        'Plan',
        'Period',
        'Amount (EUR)',
        'Issued',
        'Due',
        'Status',
        'Days late',
        'Paid on',
        'Paid (EUR)',
        'Method',
        'Reference',
      ],
      rows.map((i) => [
        i.number,
        i.tenantName,
        i.subdomain,
        i.planName,
        i.periodStart.slice(0, 7),
        i.amount / 100,
        i.issuedAt.slice(0, 10),
        i.dueDate.slice(0, 10),
        i.status === 'open' && i.overdue ? 'overdue' : i.status,
        i.overdue ? i.daysLate : null,
        i.paidAt?.slice(0, 10) ?? null,
        i.paidAmount !== null ? i.paidAmount / 100 : null,
        i.method ? METHOD_LABELS[i.method] : null,
        i.reference,
      ]),
    );
  }

  return (
    <div className="page">
      <div className="page__head">
        <div className="page__head-main">
          <h1 className="page__title">Billing</h1>
          <p className="page__meta">
            What each clinic owes NODE&nbsp;X, and whether it has arrived.
          </p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="iconbtn"
            onClick={load}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={exportCsv}
            disabled={!rows.length}
          >
            <Download size={15} aria-hidden /> Export CSV
          </button>
          <select
            className="select"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            aria-label="Month to bill"
          >
            {months.map((m, i) => (
              <option key={m} value={m}>
                {monthLabel(m, 'long')}
                {i === 0 ? ' (this month)' : ''}
              </option>
            ))}
          </select>
          <button
            className="btn btn--primary"
            onClick={() => void run()}
            disabled={running}
          >
            <Play size={15} aria-hidden /> {running ? 'Running…' : 'Run billing'}
          </button>
        </div>
      </div>

      {error && (
        <p className="banner">
          <AlertTriangle size={16} aria-hidden /> {error}
        </p>
      )}

      {summary ? (
        <div className="kpis">
          <Kpi
            tone="dark"
            label="Recurring revenue"
            icon={PiggyBank}
            value={formatEuro(summary.mrr)}
            note="per month, active paying clinics"
          />
          <Kpi
            label="Collected this month"
            icon={Coins}
            value={formatEuro(summary.paidThisMonth)}
            meter={
              summary.invoicedThisMonth
                ? summary.paidThisMonth / summary.invoicedThisMonth
                : 0
            }
            note={`of ${formatEuro(summary.invoicedThisMonth)} invoiced`}
          />
          <Kpi
            label="Overdue"
            icon={summary.overdueCount ? AlertTriangle : CircleCheck}
            tone={summary.overdueCount ? 'alert' : undefined}
            value={formatEuro(summary.overdueTotal)}
            note={`${summary.overdueCount} invoice${summary.overdueCount === 1 ? '' : 's'} past due · ${formatEuro(summary.openTotal)} open in all`}
          />
          <Kpi
            label="Not yet billed"
            icon={FileClock}
            tone={summary.unbilledClinics ? 'warn' : undefined}
            value={summary.unbilledClinics}
            note="clinics awaiting this month’s run"
          />
        </div>
      ) : (
        !error && (
          <div className="card">
            <SkeletonRows rows={2} />
          </div>
        )
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card__toolbar">
          <div className="tabs" role="tablist" aria-label="Filter invoices">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                className={`tab${filter === f.key ? ' tab--active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                {all && <span className="tab__count">{counts[f.key]}</span>}
              </button>
            ))}
          </div>
          <label className="searchbox">
            <Search size={15} aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Invoice, clinic or reference"
              aria-label="Search invoices"
            />
          </label>
        </div>

        {all === null ? (
          <SkeletonRows rows={4} />
        ) : rows.length === 0 ? (
          filter === 'overdue' && !q ? (
            <Empty
              tone="ok"
              icon={CircleCheck}
              title="Nothing is overdue"
              body="Every issued invoice was settled on time."
            />
          ) : (
            <Empty
              icon={ReceiptText}
              title={q ? 'No invoices match' : 'No invoices here yet'}
            />
          )
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Clinic</th>
                  <th>Invoice</th>
                  <th>Period</th>
                  <th className="num">Amount</th>
                  <th>Due</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <div className="namecell">
                        <ClinicMark name={i.tenantName} size={32} />
                        <div className="namecell__text">
                          <Link
                            to={`/tenants/${i.tenantId}?tab=billing`}
                            className="namecell__title"
                          >
                            {i.tenantName}
                          </Link>
                          <span className="namecell__sub">{i.subdomain}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="mono">{i.number}</span>
                      {i.planName && <span className="cell-sub">{i.planName}</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {monthLabel(i.periodStart.slice(0, 7), 'long')}
                    </td>
                    <td className="num">{formatEuro(i.amount)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {fmtDay(i.dueDate)}
                      {i.overdue && (
                        <span className="cell-sub cell-sub--alert">
                          {i.daysLate} day{i.daysLate === 1 ? '' : 's'} late
                        </span>
                      )}
                    </td>
                    <td>
                      <InvoiceState i={i} />
                    </td>
                    <td className="num">
                      {i.status === 'open' && (
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => setPaying(i)}
                        >
                          <Check size={14} aria-hidden /> Record payment
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {all && rows.length > 0 && (
          <div className="card__foot">
            <span>
              {rows.length} invoice{rows.length === 1 ? '' : 's'}
            </span>
            <span>
              {formatEuro(
                rows.reduce((s, i) => s + (i.status === 'void' ? 0 : i.amount), 0),
              )}{' '}
              in total
            </span>
          </div>
        )}
      </section>

      {paying && (
        <PaymentModal
          invoice={paying}
          onClose={() => setPaying(null)}
          onDone={(outcome) => {
            toast(
              outcome === 'paid'
                ? `Payment recorded against ${paying.number}.`
                : `${paying.number} voided.`,
            );
            setPaying(null);
            load();
            refreshBadges();
          }}
        />
      )}
    </div>
  );
}
