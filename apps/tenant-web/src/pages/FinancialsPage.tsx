import { useCallback, useEffect, useState } from 'react';
import {
  TrendingUp,
  Wallet,
  AlertCircle,
  Users,
  Stethoscope,
  DoorOpen,
  ClipboardList,
} from 'lucide-react';
import {
  analyticsApi,
  billingApi,
  financeApi,
  type FinanceSummary,
  type AgeingBucket,
  type AnalyticsDashboard,
  type BreakdownRow,
  type ReceivablesReport,
  type RevenueReport,
  humanError,
} from '../lib/api';
import { formatMoney, toDate } from '../lib/format';
import { PageHeader, EmptyState, StatusPill, LoadingRows } from '../components/ui';
import RevenueChart from '../components/RevenueChart';
import BarBreakdown, { type BarRow } from '../components/BarBreakdown';
import { dateLocale } from '../lib/strings';
import { clinicToday, plusDays, plusYears } from '../lib/clinic-time';

/**
 * The clinic's financial dashboard.
 *
 * Reachable only with `reports:read`, which under the permission matrix is
 * admin-only. The route is guarded on the API for every endpoint below — the
 * navigation entry being hidden is a convenience, not the control.
 */

type Range = '30d' | '90d' | '12m' | 'ytd';

function rangeFor(r: Range): { from: string; to: string; granularity: 'day' | 'month' } {
  // Ranges end on the clinic's today, not the browser's or UTC's.
  const to = clinicToday();
  switch (r) {
    case '30d':
      return { from: plusDays(to, -30), to, granularity: 'day' };
    case '90d':
      return { from: plusDays(to, -90), to, granularity: 'day' };
    case 'ytd':
      return { from: `${to.slice(0, 4)}-01-01`, to, granularity: 'month' };
    case '12m':
    default:
      return { from: plusYears(to, -1), to, granularity: 'month' };
  }
}

const RANGE_LABELS: Record<Range, string> = {
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  ytd: 'Year to date',
  '12m': 'Last 12 months',
};

/**
 * Ageing bucket colours are a SEQUENTIAL ramp on one hue — older debt is
 * darker. Status hues are deliberately avoided: an invoice 40 days old is not
 * an error condition, and painting it red would cry wolf.
 */
const AGEING_COLORS = ['#cfe0f5', '#8fb7e8', '#4e8dd9', '#1f5fa8'];

export default function FinancialsPage() {
  const [range, setRange] = useState<Range>('12m');
  const [dashboard, setDashboard] = useState<AnalyticsDashboard | null>(null);
  const [revenue, setRevenue] = useState<RevenueReport | null>(null);
  const [receivables, setReceivables] = useState<ReceivablesReport | null>(null);
  const [byDentist, setByDentist] = useState<BreakdownRow[]>([]);
  const [byOperatory, setByOperatory] = useState<BreakdownRow[]>([]);
  const [byProcedure, setByProcedure] = useState<BreakdownRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Today first: what came in, what went out, what is still owed. The range
  // below is the detail for whoever wants it.
  const [today, setToday] = useState<FinanceSummary | null>(null);
  useEffect(() => {
    financeApi
      .summary('today')
      .then(setToday)
      .catch(() => setToday(null));
  }, []);

  const load = useCallback(async () => {
    const { from, to, granularity } = rangeFor(range);
    setLoading(true);
    try {
      const [d, r, ar, dent, op, proc] = await Promise.all([
        analyticsApi.dashboard(from, to),
        analyticsApi.revenue(granularity, from, to),
        billingApi.receivables(),
        analyticsApi.byDentist(from, to),
        analyticsApi.byOperatory(from, to),
        analyticsApi.byProcedure(from, to),
      ]);
      setDashboard(d);
      setRevenue(r);
      setReceivables(ar);
      setByDentist(dent.rows);
      setByOperatory(op.rows);
      setByProcedure(proc.rows);
      setError(null);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const { granularity } = rangeFor(range);

  return (
    <div className="page">
      <PageHeader
        title="Financials"
        meta={dashboard ? `${dashboard.from} → ${dashboard.to}` : 'Loading…'}
        actions={
          <div className="tabs tabs--sm">
            {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
              <button
                key={r}
                className={`tab${range === r ? ' tab--active' : ''}`}
                onClick={() => setRange(r)}
              >
                {RANGE_LABELS[r]}
              </button>
            ))}
          </div>
        }
      />

      {error && <p className="formerror">{error}</p>}

      <h2 className="fin__label">Today</h2>
      <div className="sumstrip sumstrip--4" aria-label="Today">
        <div>
          <span>Collected</span>
          <strong>{today ? formatMoney(today.totalCollected ?? 0) : '…'}</strong>
        </div>
        <div>
          <span>Spent</span>
          <strong>{today ? formatMoney(today.totalExpenses ?? 0) : '…'}</strong>
        </div>
        <div>
          <span>Net</span>
          <strong
            className={
              today && (today.totalCollected ?? 0) - (today.totalExpenses ?? 0) < 0
                ? 'sumstrip__due'
                : undefined
            }
          >
            {today
              ? formatMoney((today.totalCollected ?? 0) - (today.totalExpenses ?? 0))
              : '…'}
          </strong>
        </div>
        <div>
          <span>Outstanding</span>
          <strong>{today ? formatMoney(today.outstanding) : '…'}</strong>
        </div>
      </div>

      <h2 className="fin__label">{RANGE_LABELS[range]}</h2>

      {/* Headline figures are a stat row, not a chart: six single numbers have
          no shape to plot, and a chart of them would be decoration. */}
      {dashboard && (
        <div className="stats">
          <Stat
            icon={<TrendingUp size={15} />}
            label="Billed"
            value={formatMoney(dashboard.billed)}
            sub={`${dashboard.invoiceCount} invoice${dashboard.invoiceCount === 1 ? '' : 's'}`}
          />
          <Stat
            icon={<Wallet size={15} />}
            label="Collected"
            value={formatMoney(dashboard.collected)}
            sub={
              dashboard.collectionRate === null
                ? 'Nothing billed yet'
                : `${dashboard.collectionRate}% of billed`
            }
          />
          <Stat
            icon={<AlertCircle size={15} />}
            label="Outstanding"
            value={formatMoney(dashboard.outstanding)}
            sub={`${dashboard.unpaidInvoiceCount} unpaid`}
            alert={dashboard.outstanding > 0}
          />
          <Stat
            icon={<Wallet size={15} />}
            label="Net collected"
            value={formatMoney(dashboard.netCollected)}
            sub={`after ${formatMoney(dashboard.expenses)} expenses`}
          />
          <Stat
            icon={<Users size={15} />}
            label="Patients seen"
            value={String(dashboard.patientsSeen)}
            sub={`${dashboard.proceduresDone} procedures`}
          />
        </div>
      )}

      <div className="grid">
        <section className="card span-12">
          <header className="card__head">
            <div>
              <h3>Billed vs collected</h3>
              <p className="card__sub">
                The gap between the lines is what has been invoiced but not yet paid.
              </p>
            </div>
          </header>
          {loading && !revenue ? (
            <LoadingRows rows={3} label="Loading" />
          ) : revenue ? (
            <RevenueChart data={revenue.series} granularity={granularity} />
          ) : null}
        </section>

        <section className="card span-6">
          <header className="card__head">
            <h3>
              <AlertCircle size={16} aria-hidden /> Accounts receivable
            </h3>
          </header>
          {receivables === null ? (
            <LoadingRows rows={3} label="Loading" />
          ) : receivables.invoiceCount === 0 ? (
            <EmptyState
              icon={<Wallet size={20} />}
              title="Nothing outstanding"
              body="Every invoice has been settled."
            />
          ) : (
            <>
              <p className="statbig">
                {formatMoney(receivables.totalOutstanding)}
                <span className="cell-sub">
                  {' '}
                  across {receivables.invoiceCount} invoice
                  {receivables.invoiceCount === 1 ? '' : 's'}
                </span>
              </p>
              <BarBreakdown
                rows={receivables.buckets.map((b: AgeingBucket, i: number): BarRow => ({
                  label: b.label,
                  value: b.amount,
                  meta: `${b.count} invoice${b.count === 1 ? '' : 's'}`,
                  color: AGEING_COLORS[i],
                }))}
                emptyText="Nothing outstanding."
              />
            </>
          )}
        </section>

        <section className="card span-6">
          <header className="card__head">
            <h3>
              <Stethoscope size={16} aria-hidden /> Production by clinician
            </h3>
          </header>
          <p className="card__sub">
            From the procedure log, so each person is credited with the work they actually
            performed.
          </p>
          <BarBreakdown
            rows={byDentist.map((r): BarRow => ({
              label: r.clinicianName ?? r.label ?? 'Unattributed',
              value: r.production,
              meta: `${r.procedureCount} procedures`,
            }))}
          />
        </section>

        <section className="card span-6">
          <header className="card__head">
            <h3>
              <DoorOpen size={16} aria-hidden /> Production by room
            </h3>
          </header>
          <BarBreakdown
            rows={byOperatory.map((r): BarRow => ({
              label: r.operatoryName ?? 'No room assigned',
              value: r.production,
              meta: `${r.bookedHours ?? 0}h booked`,
            }))}
          />
        </section>

        <section className="card span-6">
          <header className="card__head">
            <h3>
              <ClipboardList size={16} aria-hidden /> Production by procedure
            </h3>
          </header>
          <BarBreakdown
            rows={byProcedure.slice(0, 10).map((r): BarRow => ({
              label: r.label ?? '—',
              value: r.production,
              meta: `${r.procedureCount}× · avg ${formatMoney(r.averageFee ?? 0)}`,
            }))}
          />
        </section>

        {receivables && receivables.invoices.length > 0 && (
          <section className="card span-12">
            <header className="card__head">
              <h3>Outstanding invoices</h3>
            </header>
            <table className="table table--compact">
              <thead>
                <tr>
                  <th className="hide-sm">Invoice</th>
                  <th>Patient</th>
                  <th className="hide-sm hide-md">Issued</th>
                  <th className="num hide-sm">Total</th>
                  <th className="num hide-sm hide-md">Paid</th>
                  <th className="num">Balance</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {receivables.invoices.map((i) => (
                  <tr key={i.invoiceId}>
                    <td className="hide-sm" style={{ fontWeight: 600 }}>
                      {i.invoiceNumber}
                    </td>
                    <td>
                      {i.patientName}
                      {/* On a phone the invoice number rides under the name. */}
                      <span className="cell-sub only-sm">{i.invoiceNumber}</span>
                    </td>
                    <td className="muted hide-sm hide-md">
                      {toDate(i.issuedAt).toLocaleDateString(dateLocale())}
                    </td>
                    <td className="num hide-sm">{formatMoney(i.total)}</td>
                    <td className="num hide-sm hide-md">{formatMoney(i.paid)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>
                      {formatMoney(i.balance)}
                    </td>
                    <td>
                      {/* Colour only once an invoice is past 60 days; a young
                          one is the normal case and reads as plain text. */}
                      {i.bucket === 'over_90' || i.bucket === 'd61_90' ? (
                        <StatusPill
                          status={i.bucket === 'over_90' ? 'severe' : 'moderate'}
                          label={`${i.daysOutstanding}d`}
                        />
                      ) : (
                        <span className="muted">{i.daysOutstanding}d</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
  alert,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <div className={`stat${alert ? ' stat--alert' : ''}`}>
      <span className="stat__label">
        {icon} {label}
      </span>
      <span className="stat__value">{value}</span>
      {sub && <span className="stat__sub">{sub}</span>}
    </div>
  );
}
