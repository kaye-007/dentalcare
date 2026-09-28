import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, BarChart3, Download } from 'lucide-react';
import { MINOR_UNITS, formatRate, writeXlsx, type Sheet } from '@dentalcare/shared';
import {
  reportsApi,
  type ReportOverview,
  type ReportBreakdownRow,
  type VatReport,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader, EmptyState, LoadingRows } from '../components/ui';
import { currentCurrency, formatMoney, formatQty, plural, toDate } from '../lib/format';
import { wallNow } from '../lib/clinic-time';
import { useIsPhone } from '../lib/useIsPhone';
import { dateLocale } from '../lib/strings';

/**
 * Reports answer the owner's questions, a section each:
 *
 *   Money         how much came in, went out, and is still owed; where it
 *                 came from and went; how patients paid; the TVSH charged
 *   Clinic        how many appointments, cancellations, no-shows and new
 *                 patients; who saw them; what was done in the chair
 *   Stock and lab what the treatment used up; where the lab work stands
 *
 * Each section opens with its answers and follows with the detail. Export
 * writes the same figures to an Excel workbook for the accountant; the
 * TVSH there adds the split between fiscal and internal documents.
 *
 * Days are the clinic's days (the API reads them on its clock), and the
 * period buttons start from the clinic's today.
 */

/* ── date helpers ───────────────────────────────────────── */
function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function presetRange(key: string): { from: string; to: string } {
  const now = wallNow();
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

/** "1 Apr – 28 Sep 2026", or with both years when the period crosses one. */
function periodLabel({ from, to }: { from: string; to: string }) {
  const a = toDate(from);
  const b = toDate(to);
  const sameYear = a.getFullYear() === b.getFullYear();
  const day = (d: Date, year: boolean) =>
    d.toLocaleDateString(dateLocale(), {
      day: 'numeric',
      month: 'short',
      ...(year ? { year: 'numeric' } : {}),
    });
  return `${day(a, !sameYear)} – ${day(b, true)}`;
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
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString(dateLocale(), {
    month: 'short',
  });
};

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  bank: 'Bank transfer',
};
/** Expense categories and anything else stored as a lowercase key. */
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const methodLabel = (m: string) => METHOD_LABEL[m] ?? capital(m);

/* ── export ─────────────────────────────────────────────── */

/**
 * The period's figures as an Excel workbook: a summary sheet, then one
 * sheet per breakdown. Amounts are numbers in the clinic's currency (not
 * minor units), so they add up in Excel as they do on screen.
 */
function downloadWorkbook(d: ReportOverview, vat: VatReport | null) {
  const cur = currentCurrency();
  const money = (minor: number) => minor / MINOR_UNITS;
  const t = d.totals;
  const sheets: Sheet[] = [
    {
      name: 'Summary',
      rows: [
        ['Report', 'Value'],
        ['From', d.range.from],
        ['To', d.range.to],
        [],
        [`Collected (${cur})`, money(t.collected)],
        [`Spent (${cur})`, money(t.expenses)],
        [`Net (${cur})`, money(t.profit)],
        [`Invoiced (${cur})`, money(t.invoiced)],
        [`Outstanding now (${cur})`, money(t.outstanding)],
        ...(vat ? [[`TVSH charged (${cur})`, money(vat.totals.vat)]] : []),
        [],
        ['Appointments', t.appointments],
        ['Completed', t.appointmentsCompleted],
        ['Cancelled', t.appointmentsCancelled],
        ['No-shows', t.appointmentsNoShow],
        ['New patients', t.newPatients],
        [],
        ['Lab work ordered', d.lab.ordered],
        ['Lab work fitted', d.lab.fitted],
        [`Cost of fitted lab work (${cur})`, money(d.lab.cost)],
        ['Lab work open now', d.lab.open],
        ['Lab work late now', d.lab.late],
      ],
    },
    {
      name: 'By month',
      rows: [
        ['Month', `Collected (${cur})`, `Spent (${cur})`, `Net (${cur})`],
        ...d.monthlyTrend.map((p) => [
          p.month,
          money(p.collected),
          money(p.expenses),
          money(p.profit),
        ]),
      ],
    },
    {
      name: 'Billed by treatment',
      rows: [
        ['Treatment', `Billed (${cur})`],
        ...d.revenueByTreatment.map((r) => [r.label, money(r.value)]),
      ],
    },
    {
      name: 'Spending',
      rows: [
        ['Category', `Spent (${cur})`],
        ...d.expensesByCategory.map((r) => [capital(r.label), money(r.value)]),
      ],
    },
    {
      name: 'Payments',
      rows: [
        ['Method', `Collected (${cur})`],
        ...d.paymentsByMethod.map((r) => [methodLabel(r.label), money(r.value)]),
      ],
    },
  ];
  if (vat) {
    sheets.push({
      name: 'TVSH',
      rows: [
        [
          'Rate (%)',
          `Before TVSH (${cur})`,
          `TVSH (${cur})`,
          `Total (${cur})`,
          'Invoices',
        ],
        ...vat.bands.map((b) => [
          b.rateBp / 100,
          money(b.net),
          money(b.vat),
          money(b.gross),
          b.invoices,
        ]),
        ['Total', money(vat.totals.net), money(vat.totals.vat), money(vat.totals.gross)],
        [],
        [
          'Document',
          `Before TVSH (${cur})`,
          `TVSH (${cur})`,
          `Total (${cur})`,
          'Invoices',
        ],
        ...vat.documents.map((doc) => [
          doc.documentKind === 'internal'
            ? 'Internal'
            : doc.registered
              ? 'Fiscal, registered'
              : 'Fiscal, not registered yet',
          money(doc.net),
          money(doc.vat),
          money(doc.gross),
          doc.invoices,
        ]),
      ],
    });
  }
  sheets.push(
    {
      name: 'Practitioners',
      rows: [
        ['Practitioner', 'Appointments', 'Completed'],
        ...d.appointmentsByDentist.map((r) => [r.label, r.total, r.completed]),
      ],
    },
    {
      name: 'Treatments performed',
      rows: [
        ['Treatment', 'Times'],
        ...d.treatmentsPerformed.map((r) => [r.label, r.value]),
      ],
    },
    {
      name: 'Stock used',
      rows: [
        ['Item', 'Quantity', 'Unit'],
        ...d.consumption.map((r) => [r.label, r.value, r.unit]),
      ],
    },
  );

  const blob = new Blob([writeXlsx(sheets)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `DentalCare report ${d.range.from} to ${d.range.to}.xlsx`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/* ── page ───────────────────────────────────────────────── */
export default function ReportsPage() {
  const { can } = useAuth();
  const canAccess = can('reports:read');

  const [preset, setPreset] = useState<string>('last_6');
  const [range, setRange] = useState(() => presetRange('last_6'));
  const [data, setData] = useState<ReportOverview | null>(null);
  const [vat, setVat] = useState<VatReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const presetsRef = useRef<HTMLDivElement>(null);

  // On a phone the period buttons scroll sideways; the chosen one is kept in
  // view, so "Last 6 months" is not hidden past the edge when the page opens.
  useEffect(() => {
    presetsRef.current
      ?.querySelector<HTMLElement>('.tab--active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [preset]);

  useEffect(() => {
    if (!canAccess) return;
    // A period chosen while another is loading wins: the older answer is
    // dropped when it arrives.
    let current = true;
    setLoading(true);
    setFailed(false);
    Promise.all([
      reportsApi.overview(range.from, range.to),
      reportsApi.vat(range.from, range.to),
    ])
      .then(([overview, tax]) => {
        if (!current) return;
        setData(overview);
        setVat(tax);
      })
      .catch(() => current && setFailed(true))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [canAccess, range.from, range.to, attempt]);

  if (!canAccess) {
    return (
      <div className="page">
        <EmptyState
          framed
          icon={<Lock size={22} />}
          title="Owner access only"
          body="Reports and profit analytics are restricted to the clinic owner."
        />
      </div>
    );
  }

  const t = data?.totals;
  // A period with nothing in it says so once, instead of a page of zeros.
  const quiet =
    !!data &&
    !!t &&
    [t.invoiced, t.collected, t.expenses, t.appointments, t.newPatients].every(
      (n) => n === 0,
    ) &&
    data.treatmentsPerformed.length === 0 &&
    data.consumption.length === 0 &&
    data.lab.ordered === 0 &&
    data.lab.open === 0;

  return (
    <div className="page">
      <PageHeader
        title="Reports"
        meta={data ? periodLabel(data.range) : '…'}
        actions={
          <button
            type="button"
            className="btn btn--ghost"
            disabled={!data || loading}
            onClick={() => data && downloadWorkbook(data, vat)}
          >
            <Download size={15} aria-hidden /> Export
          </button>
        }
      />

      <div className="toolbar">
        <div className="tabs" ref={presetsRef}>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={`tab${preset === p.key ? ' tab--active' : ''}`}
              onClick={() => {
                setPreset(p.key);
                setRange(presetRange(p.key));
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="rangepick">
          <input
            type="date"
            aria-label="From date"
            value={range.from}
            max={range.to}
            onChange={(e) => {
              setPreset('');
              setRange((r) => ({ ...r, from: e.target.value }));
            }}
          />
          <span className="muted">–</span>
          <input
            type="date"
            aria-label="To date"
            value={range.to}
            min={range.from}
            onChange={(e) => {
              setPreset('');
              setRange((r) => ({ ...r, to: e.target.value }));
            }}
          />
        </div>
      </div>

      {failed ? (
        <div className="card pad reports__failed" role="alert">
          <p>The report could not be loaded. Check the connection, then try again.</p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      ) : !data || !t ? (
        <div className="card">
          <LoadingRows rows={3} label="Loading report" />
        </div>
      ) : quiet ? (
        <EmptyState
          framed
          icon={<BarChart3 size={22} />}
          title="Nothing in this period"
          body="No money, appointments or treatment were recorded between these dates. Try a longer period, such as This year."
        />
      ) : (
        <div
          className={`reports${loading ? ' reports--updating' : ''}`}
          aria-busy={loading}
        >
          <section aria-labelledby="reports-money">
            <h2 className="fin__label" id="reports-money">
              Money
            </h2>
            <div className="sumstrip sumstrip--4">
              <div>
                <span>Collected</span>
                <strong>{formatMoney(t.collected)}</strong>
              </div>
              <div>
                <span>Spent</span>
                <strong>{formatMoney(t.expenses)}</strong>
              </div>
              <div>
                <span>Net</span>
                <strong className={t.profit < 0 ? 'sumstrip__due' : 'sumstrip__pos'}>
                  {formatMoney(t.profit)}
                </strong>
              </div>
              <div>
                <span>Outstanding now</span>
                <strong>{formatMoney(t.outstanding)}</strong>
              </div>
            </div>

            <div className="grid">
              <div className="card span-12">
                <div className="card__head">
                  <div>
                    <h2>Month by month</h2>
                    <p className="card__sub">
                      Collected and spent, with the net as a line ·{' '}
                      {formatMoney(t.invoiced)} invoiced in this period
                    </p>
                  </div>
                  <div className="chart-legend">
                    <span className="chart-key chart-key--collected" /> collected
                    <span className="chart-key chart-key--expenses" /> spent
                    <span className="chart-key chart-key--profit" /> net
                  </div>
                </div>
                <TrendChart points={data.monthlyTrend} />
              </div>

              <BreakdownCard
                className="span-6"
                title="Where it came from"
                sub="Invoiced, by treatment"
                rows={data.revenueByTreatment}
                tone="teal"
              />
              <BreakdownCard
                className="span-6"
                title="Where it went"
                sub="Spent, by category"
                rows={data.expensesByCategory}
                tone="warn"
                label={(r) => capital(r.label)}
              />
              <BreakdownCard
                className="span-6"
                title="How patients paid"
                sub="Collected, by method"
                rows={data.paymentsByMethod}
                tone="info"
                label={(r) => methodLabel(r.label)}
              />
              <VatCard className="span-6" vat={vat} />
            </div>
          </section>

          <section aria-labelledby="reports-clinic">
            <h2 className="fin__label" id="reports-clinic">
              Clinic
            </h2>
            <div className="sumstrip sumstrip--4">
              <div>
                <span>Appointments</span>
                <strong>{t.appointments}</strong>
                <span>{t.appointmentsCompleted} completed</span>
              </div>
              <div>
                <span>Cancelled</span>
                <strong>{t.appointmentsCancelled}</strong>
              </div>
              <div>
                <span>No-shows</span>
                <strong>{t.appointmentsNoShow}</strong>
              </div>
              <div>
                <span>New patients</span>
                <strong>{t.newPatients}</strong>
              </div>
            </div>

            <div className="grid">
              <div className="card span-6">
                <div className="card__head">
                  <div>
                    <h2>By practitioner</h2>
                    <p className="card__sub">Appointments, and how many were completed</p>
                  </div>
                </div>
                {data.appointmentsByDentist.length === 0 ? (
                  <p className="pad muted reports__none">
                    No appointments in this period.
                  </p>
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
              <BreakdownCard
                className="span-6"
                title="Treatments performed"
                sub="Completed in the chair, by service"
                rows={data.treatmentsPerformed}
                tone="teal"
                value={(r) => `${r.value}×`}
              />
            </div>
          </section>

          <section aria-labelledby="reports-stock">
            <h2 className="fin__label" id="reports-stock">
              Stock and lab
            </h2>
            <div className="grid">
              <BreakdownCard
                className="span-6"
                title="Stock used"
                sub="Recorded as used, by item"
                rows={data.consumption}
                tone="info"
                value={(r) => `${formatQty(r.value)} ${r.unit}`}
              />
              <LabCard className="span-6" lab={data.lab} canOpen={can('lab:read')} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/* ── TVSH: what was charged, by rate ────────────────────── */
function VatCard({ vat, className = '' }: { vat: VatReport | null; className?: string }) {
  const fiscal = (registered: boolean) =>
    vat?.documents
      .filter((d) => d.documentKind === 'fiscal' && d.registered === registered)
      .reduce((n, d) => n + d.invoices, 0) ?? 0;
  const internal =
    vat?.documents
      .filter((d) => d.documentKind === 'internal')
      .reduce((n, d) => n + d.invoices, 0) ?? 0;
  const pending = fiscal(false);
  return (
    <div className={`card ${className}`}>
      <div className="card__head">
        <div>
          <h2>TVSH</h2>
          <p className="card__sub">On invoices issued in this period</p>
        </div>
        {vat && vat.bands.length > 0 && (
          <strong className="reports__figure">{formatMoney(vat.totals.vat)}</strong>
        )}
      </div>
      {!vat || vat.bands.length === 0 ? (
        <p className="pad muted reports__none">No invoices in this period.</p>
      ) : (
        <>
          <ul className="list">
            {vat.bands.map((b) => (
              <li className="row" key={b.rateBp}>
                <span className="row__main">
                  <span className="row__title">
                    {b.rateBp === 0 ? 'Exempt' : `TVSH ${formatRate(b.rateBp)}`}
                  </span>
                  <span className="row__sub">
                    {formatMoney(b.net)} before TVSH · {plural(b.invoices, 'invoice')}
                  </span>
                </span>
                <span className="row__amount">{formatMoney(b.vat)}</span>
              </li>
            ))}
          </ul>
          <p className="pad muted reports__note">
            {[
              fiscal(true) > 0 && `${plural(fiscal(true), 'fiscal invoice')} registered`,
              pending > 0 && `${pending} not registered yet`,
              internal > 0 && `${plural(internal, 'internal document')}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </>
      )}
    </div>
  );
}

/* ── lab work: where it stands ──────────────────────────── */
function LabCard({
  lab,
  canOpen,
  className = '',
}: {
  lab: ReportOverview['lab'];
  canOpen: boolean;
  className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      <div className="card__head">
        <div>
          <h2>Lab work</h2>
          <p className="card__sub">Open and late are as of today</p>
        </div>
        {canOpen && (
          <Link to="/lab" className="btn btn--ghost btn--sm">
            Open lab work
          </Link>
        )}
      </div>
      <ul className="list">
        <li className="row">
          <span className="row__main">
            <span className="row__title">Open</span>
            <span className="row__sub">
              Being prepared, at the lab, or back and waiting to fit
            </span>
          </span>
          <span className="row__amount">{lab.open}</span>
        </li>
        <li className="row">
          <span className="row__main">
            <span className="row__title">Late</span>
            <span className="row__sub">Past the day the lab promised</span>
          </span>
          <span className={`row__amount${lab.late > 0 ? ' sumstrip__due' : ''}`}>
            {lab.late}
          </span>
        </li>
        <li className="row">
          <span className="row__main">
            <span className="row__title">Ordered in this period</span>
          </span>
          <span className="row__amount">{lab.ordered}</span>
        </li>
        <li className="row">
          <span className="row__main">
            <span className="row__title">Fitted in this period</span>
            {lab.cost > 0 && (
              <span className="row__sub">{formatMoney(lab.cost)} lab cost</span>
            )}
          </span>
          <span className="row__amount">{lab.fitted}</span>
        </li>
      </ul>
    </div>
  );
}

/* ── SVG grouped-bar trend chart with net line ──────────── */
function TrendChart({ points }: { points: ReportOverview['monthlyTrend'] }) {
  // Drawn narrower on a phone, so the month names are not scaled down to
  // a few pixels with the rest of the picture.
  const W = useIsPhone() ? 420 : 900,
    H = 240,
    PAD_L = 8,
    PAD_R = 8,
    PAD_T = 16,
    PAD_B = 28;
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
    return <p className="pad muted reports__none">No data in this period.</p>;
  }

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label="Month by month: collected, spent and net"
      >
        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--border-strong)"
        />
        {points.map((p, i) => {
          const cx = PAD_L + groupW * i + groupW / 2;
          return (
            <g key={p.month}>
              <rect
                x={cx - barW - 2}
                width={barW}
                y={Math.min(yOf(p.collected), zeroY)}
                height={Math.abs(zeroY - yOf(p.collected)) || 1}
                rx={3}
                fill="var(--data-1)"
                opacity={0.9}
              >
                <title>{`${MONTH_LABEL(p.month)} collected: ${formatMoney(p.collected)}`}</title>
              </rect>
              <rect
                x={cx + 2}
                width={barW}
                y={Math.min(yOf(p.expenses), zeroY)}
                height={Math.abs(zeroY - yOf(p.expenses)) || 1}
                rx={3}
                fill="var(--data-2)"
                opacity={0.9}
              >
                <title>{`${MONTH_LABEL(p.month)} spent: ${formatMoney(p.expenses)}`}</title>
              </rect>
              <text
                x={cx}
                y={H - 8}
                textAnchor="middle"
                fontSize={11}
                fill="var(--muted)"
              >
                {MONTH_LABEL(p.month)}
              </text>
            </g>
          );
        })}
        <polyline
          points={profitPts.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
        {profitPts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={3.2} fill="var(--ink)">
            <title>{`${MONTH_LABEL(points[i]!.month)} net: ${formatMoney(points[i]!.profit)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

/* ── proportional bar list ──────────────────────────────── */
function BreakdownCard<R extends ReportBreakdownRow>({
  title,
  sub,
  rows,
  tone,
  label = (r) => r.label,
  value = (r) => formatMoney(r.value),
  className = '',
}: {
  title: string;
  sub: string;
  rows: R[];
  tone: 'teal' | 'warn' | 'info';
  label?: (row: R) => string;
  /** Money unless said otherwise. */
  value?: (row: R) => string;
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
        <p className="pad muted reports__none">Nothing in this period.</p>
      ) : (
        <ul className="bars">
          {rows.map((r) => (
            <li className="bars__row" key={r.label}>
              <span className="bars__label">{label(r)}</span>
              <span className="bars__track">
                <span
                  className={`bars__fill bars__fill--${tone}`}
                  style={{ width: `${(r.value / max) * 100}%` }}
                />
              </span>
              <span className="bars__value">{value(r)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
