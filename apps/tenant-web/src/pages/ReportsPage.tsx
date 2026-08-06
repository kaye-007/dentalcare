import { useEffect, useMemo, useState } from 'react';
import { Lock, BarChart3 } from 'lucide-react';
import { reportsApi, type ReportOverview, type ReportBreakdownRow } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader, EmptyState } from '../components/ui';
import { formatMoney, plural } from '../lib/format';

/* ── date helpers ───────────────────────────────────────── */
function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function presetRange(key: string): { from: string; to: string } {
  const now = new Date();
  const today = iso(now);
  switch (key) {
    case 'this_month':
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case 'last_month': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: iso(first), to: iso(last) };
    }
    case 'last_3':
      return { from: iso(new Date(now.getFullYear(), now.getMonth() - 2, 1)), to: today };
    case 'this_year':
      return { from: iso(new Date(now.getFullYear(), 0, 1)), to: today };
    case 'last_6':
    default:
      return { from: iso(new Date(now.getFullYear(), now.getMonth() - 5, 1)), to: today };
  }
}

const PRESETS = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_3', label: 'Last 3 months' },
  { key: 'last_6', label: 'Last 6 months' },
  { key: 'this_year', label: 'This year' },
] as const;

const MONTH_LABEL = (m: string) => {
  const [y, mo] = m.split('-');
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-GB', { month: 'short' });
};

/* ── page ───────────────────────────────────────────────── */
export default function ReportsPage() {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const [preset, setPreset] = useState<string>('last_6');
  const [range, setRange] = useState(() => presetRange('last_6'));
  const [data, setData] = useState<ReportOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isOwner) return;
    setLoading(true);
    reportsApi.overview(range.from, range.to)
      .then(setData)
      .finally(() => setLoading(false));
  }, [isOwner, range.from, range.to]);

  if (!isOwner) {
    return (
      <div className="page">
        <EmptyState framed icon={<Lock size={22} />} title="Owner access only"
          body="Reports and profit analytics are restricted to the clinic owner." />
      </div>
    );
  }

  const t = data?.totals;

  return (
    <div className="page">
      <PageHeader
        title="Reports"
        meta={
          t
            ? `${plural(t.newPatients, 'new patient')} · ${plural(t.appointments, 'appointment')}, ${t.appointmentsCompleted} completed · ${formatMoney(t.outstanding)} currently outstanding`
            : '…'
        }
      />

      <div className="toolbar">
        <div className="tabs">
          {PRESETS.map((p) => (
            <button key={p.key} className={`tab${preset === p.key ? ' tab--active' : ''}`}
              onClick={() => { setPreset(p.key); setRange(presetRange(p.key)); }}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="rangepick">
          <input type="date" value={range.from} max={range.to}
            onChange={(e) => { setPreset(''); setRange((r) => ({ ...r, from: e.target.value })); }} />
          <span className="muted">–</span>
          <input type="date" value={range.to} min={range.from}
            onChange={(e) => { setPreset(''); setRange((r) => ({ ...r, to: e.target.value })); }} />
        </div>
      </div>

      {loading || !data ? (
        <div className="card"><div className="pad muted">Loading report…</div></div>
      ) : (
        <>
          <div className="sumstrip sumstrip--4">
            <div><span>Collected</span><strong>{formatMoney(data.totals.collected)}</strong></div>
            <div><span>Expenses</span><strong>{formatMoney(data.totals.expenses)}</strong></div>
            <div>
              <span>Profit</span>
              <strong className={data.totals.profit < 0 ? 'sumstrip__due' : 'sumstrip__pos'}>
                {formatMoney(data.totals.profit)}
              </strong>
            </div>
            <div><span>Invoiced</span><strong>{formatMoney(data.totals.invoiced)}</strong></div>
          </div>

          <div className="grid">
            <div className="card span-12">
              <div className="card__head">
                <div>
                  <h2>Monthly trend</h2>
                  <p className="card__sub">Collected vs expenses, with profit per month</p>
                </div>
                <div className="chart-legend">
                  <span className="chart-key chart-key--collected" /> collected
                  <span className="chart-key chart-key--expenses" /> expenses
                  <span className="chart-key chart-key--profit" /> profit
                </div>
              </div>
              <TrendChart points={data.monthlyTrend} />
            </div>

            <BreakdownCard className="span-6" title="Revenue by treatment"
              sub="From invoice line items in range" rows={data.revenueByTreatment} tone="teal" />
            <BreakdownCard className="span-6" title="Expenses by category"
              sub="In range" rows={data.expensesByCategory} tone="warn" capitalize />
            <BreakdownCard className="span-6" title="Payments by method"
              sub="Collected in range" rows={data.paymentsByMethod} tone="info" capitalize />

            <div className="card span-6">
              <div className="card__head">
                <div>
                  <h2>Appointments by practitioner</h2>
                  <p className="card__sub">Total and completed in range</p>
                </div>
              </div>
              {data.appointmentsByDentist.length === 0 ? (
                <p className="pad muted" style={{ fontSize: 13 }}>No appointments in this range.</p>
              ) : (
                <ul className="list">
                  {data.appointmentsByDentist.map((d) => (
                    <li className="row" key={d.label}>
                      <span className="row__main">
                        <span className="row__title">{d.label}</span>
                        <span className="row__sub">{d.completed} completed</span>
                      </span>
                      <span className="row__amount">{d.total}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}

      {!loading && data && data.totals.invoiced === 0 && data.totals.expenses === 0 && (
        <div style={{ marginTop: 16 }}>
          <EmptyState framed icon={<BarChart3 size={22} />} title="Nothing in this range"
            body="Try a wider date range, or record invoices, payments, and expenses first." />
        </div>
      )}
    </div>
  );
}

/* ── SVG grouped-bar trend chart with profit line ───────── */
function TrendChart({ points }: { points: ReportOverview['monthlyTrend'] }) {
  const W = 900, H = 240, PAD_L = 8, PAD_R = 8, PAD_T = 16, PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const { maxV, minP } = useMemo(() => {
    const vals = points.flatMap((p) => [p.collected, p.expenses, p.profit, 0]);
    return { maxV: Math.max(...vals, 1), minP: Math.min(...vals, 0) };
  }, [points]);

  const span = maxV - minP || 1;
  const yOf = (v: number) => PAD_T + innerH - ((v - minP) / span) * innerH;
  const zeroY = yOf(0);

  const groupW = innerW / Math.max(points.length, 1);
  const barW = Math.min(26, groupW / 3.2);

  const profitPts = points.map((p, i) => ({
    x: PAD_L + groupW * i + groupW / 2,
    y: yOf(p.profit),
  }));

  if (points.length === 0) {
    return <p className="pad muted" style={{ fontSize: 13 }}>No data in this range.</p>;
  }

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Monthly finance trend">
        <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY} stroke="var(--border-strong)" />
        {points.map((p, i) => {
          const cx = PAD_L + groupW * i + groupW / 2;
          return (
            <g key={p.month}>
              <rect x={cx - barW - 2} width={barW}
                y={Math.min(yOf(p.collected), zeroY)} height={Math.abs(zeroY - yOf(p.collected)) || 1}
                rx={3} fill="var(--teal)" opacity={0.9}>
                <title>{`${p.month} collected: ${p.collected}`}</title>
              </rect>
              <rect x={cx + 2} width={barW}
                y={Math.min(yOf(p.expenses), zeroY)} height={Math.abs(zeroY - yOf(p.expenses)) || 1}
                rx={3} fill="#d9a05b" opacity={0.9}>
                <title>{`${p.month} expenses: ${p.expenses}`}</title>
              </rect>
              <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
                {MONTH_LABEL(p.month)}
              </text>
            </g>
          );
        })}
        <polyline
          points={profitPts.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none" stroke="var(--ink)" strokeWidth={1.8} strokeLinejoin="round"
        />
        {profitPts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={3.2} fill="var(--ink)">
            <title>{`${points[i]!.month} profit: ${points[i]!.profit}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

/* ── proportional bar list ──────────────────────────────── */
function BreakdownCard({
  title,
  sub,
  rows,
  tone,
  capitalize = false,
  className = '',
}: {
  title: string;
  sub: string;
  rows: ReportBreakdownRow[];
  tone: 'teal' | 'warn' | 'info';
  capitalize?: boolean;
  className?: string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className={`card ${className}`}>
      <div className="card__head">
        <div>
          <h2>{title}</h2>
          <p className="card__sub">{sub}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="pad muted" style={{ fontSize: 13 }}>No data in this range.</p>
      ) : (
        <ul className="bars">
          {rows.map((r) => (
            <li className="bars__row" key={r.label}>
              <span className="bars__label" style={capitalize ? { textTransform: 'capitalize' } : undefined}>
                {r.label}
              </span>
              <span className="bars__track">
                <span className={`bars__fill bars__fill--${tone}`} style={{ width: `${(r.value / max) * 100}%` }} />
              </span>
              <span className="bars__value">{formatMoney(r.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
