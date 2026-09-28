import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarClock,
  ChevronRight,
  CircleCheck,
  Clock,
  Coins,
  Hourglass,
  Moon,
  PiggyBank,
  ReceiptText,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import {
  api,
  formatEuro,
  trialState,
  type ActivityEntry,
  type BillingSummary,
  type FleetUsage,
  type PlanDetail,
  type PlatformOverview,
  type SubscriptionInvoice,
  type TenantRow,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  daysSince,
  fmtNumber,
  greeting,
  lastMonths,
  monthKey,
  monthLabel,
  plural,
  relative,
} from '../lib/format';
import { describe, subjectOf } from '../lib/activity';
import { ColumnChart, ShareBars } from '../components/charts';
import { Empty, Kpi, SkeletonRows } from '../components/ui';
import { useShell } from '../components/shell';

/** A clinic this quiet, this long after it was set up, is a churn risk. */
const QUIET_DAYS = 30;
/** How much warning a trial ending gets on this screen. */
const TRIAL_SOON_DAYS = 3;

interface Data {
  overview: PlatformOverview;
  billing: BillingSummary;
  tenants: TenantRow[];
  invoices: SubscriptionInvoice[];
  usage: FleetUsage | null;
  plans: PlanDetail[];
  activity: ActivityEntry[];
}

interface Attention {
  key: string;
  tone: 'danger' | 'warn' | 'info' | 'neutral';
  icon: LucideIcon;
  title: string;
  sub: string;
  to: string;
  /** Lower first. */
  rank: number;
}

/**
 * The first screen: how the business is doing, and what wants a person
 * today. Figures across the top, the things to act on beside the revenue
 * chart, then the shape of the fleet and what was done most recently.
 */
export default function OverviewPage() {
  const { admin } = useAuth();
  const { version, openCreate } = useShell();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.overview(),
      api.billingSummary(),
      api.tenants(),
      api.subscriptionInvoices({}),
      // Usage is the heaviest read and only feeds one signal; the page stands without it.
      api.usage().catch(() => null),
      api.plansAll(),
      api.activity({ limit: 6 }),
    ])
      .then(([overview, billing, tenants, invoices, usage, plans, activity]) => {
        setData({
          overview,
          billing,
          tenants,
          invoices,
          usage,
          plans,
          activity: activity.rows,
        });
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load, version]);

  const attention = useMemo(() => (data ? needsAttention(data) : []), [data]);

  const revenue = useMemo(() => {
    if (!data) return [];
    return lastMonths(6).map((key) => {
      const inMonth = data.invoices.filter(
        (i) => monthKey(i.periodStart) === key && i.status !== 'void',
      );
      return {
        key,
        label: monthLabel(key),
        title: monthLabel(key, 'long'),
        values: [
          inMonth.reduce((s, i) => s + i.amount, 0),
          inMonth.reduce(
            (s, i) => s + (i.status === 'paid' ? (i.paidAmount ?? i.amount) : 0),
            0,
          ),
        ],
      };
    });
  }, [data]);

  const growth = useMemo(() => {
    if (!data) return [];
    return lastMonths(6).map((key) => ({
      key,
      label: monthLabel(key),
      title: monthLabel(key, 'long'),
      values: [data.tenants.filter((t) => monthKey(t.created_at) === key).length],
    }));
  }, [data]);

  const planMap = useMemo(
    () => new Map(data?.plans.map((p) => [p.id, p.name]) ?? []),
    [data],
  );
  const firstName = admin?.fullName?.split(/\s+/)[0] ?? '';
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <div className="page">
      <div className="page__head">
        <div className="page__head-main">
          <p className="greet__date">{today}</p>
          <h1 className="page__title">
            {greeting()}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="page__meta">
            {data
              ? attention.length === 0
                ? 'Nothing needs you right now. Every clinic is in order.'
                : `${attention.length} thing${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} a look today.`
              : 'Loading the fleet…'}
          </p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw size={15} aria-hidden /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <p className="banner">
          <AlertTriangle size={16} aria-hidden /> {error}
        </p>
      )}

      {data ? (
        <>
          {attention.length > 0 && (
            <section className="card attn-card">
              <div className="card__head">
                <h2>Needs attention</h2>
                {attention.length > 0 && (
                  <span className="pill pill--danger">{attention.length}</span>
                )}
              </div>
              <ul className="attn">
                {attention.slice(0, 7).map((a) => (
                  <li key={a.key}>
                    <Link to={a.to} className="attn__item">
                      <span className={`attn__icon attn__icon--${a.tone}`}>
                        <a.icon size={16} aria-hidden />
                      </span>
                      <span className="attn__main">
                        <span className="attn__title">{a.title}</span>
                        <span className="attn__sub">{a.sub}</span>
                      </span>
                      <ChevronRight size={16} className="attn__go" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
              {attention.length > 7 && (
                <div className="card__foot">
                  <span>{attention.length - 7} more</span>
                  <Link className="link" to="/clinics">
                    All clinics <ArrowRight size={14} />
                  </Link>
                </div>
              )}
            </section>
          )}

          <div className="kpis">
            <Kpi
              tone="dark"
              label="Monthly recurring revenue"
              icon={PiggyBank}
              value={formatEuro(data.billing.mrr)}
              note={`${formatEuro(data.billing.mrr * 12)} a year · ${plural(
                data.plans.reduce((s, p) => s + p.paying_count, 0),
                'paying clinic',
              )}`}
              href="/plans"
            />
            <Kpi
              label="Clinics"
              icon={Building2}
              value={fmtNumber(data.overview.clinics.active)}
              note={`${data.overview.trials} on trial · ${data.overview.clinics.suspended} suspended`}
              href="/clinics"
            />
            <Kpi
              label="Collected this month"
              icon={Coins}
              value={formatEuro(data.billing.paidThisMonth)}
              meter={
                data.billing.invoicedThisMonth
                  ? data.billing.paidThisMonth / data.billing.invoicedThisMonth
                  : 0
              }
              note={`of ${formatEuro(data.billing.invoicedThisMonth)} invoiced`}
              href="/billing"
            />
            <Kpi
              label="Overdue"
              icon={data.billing.overdueCount ? AlertTriangle : CircleCheck}
              tone={data.billing.overdueCount ? 'alert' : undefined}
              value={formatEuro(data.billing.overdueTotal)}
              note={
                data.billing.overdueCount
                  ? `${data.billing.overdueCount} invoice${data.billing.overdueCount === 1 ? '' : 's'} past due`
                  : 'Everything issued is on time'
              }
              href="/billing"
            />
          </div>

          <div className="grid">
            <section className="card span-8">
              <div className="card__head card__head--flush">
                <div>
                  <h2>Subscription revenue</h2>
                  <p className="card__sub">
                    Invoiced and collected by billing month, last six months.
                  </p>
                </div>
              </div>
              <ColumnChart
                columns={revenue}
                series={[
                  { name: 'Invoiced', color: 'var(--data-3)' },
                  { name: 'Collected', color: 'var(--data-2)' },
                ]}
                format={(n) => formatEuro(n)}
                formatAxis={(n) =>
                  n >= 100_000
                    ? `€${Math.round(n / 100_000)}k`
                    : `€${Math.round(n / 100)}`
                }
                ariaLabel="Subscription revenue by month, invoiced and collected"
              />
            </section>

            <section className="card span-4">
              <div className="card__head">
                <h2>Recent activity</h2>
                <Link className="link" to="/activity">
                  View all <ArrowRight size={14} />
                </Link>
              </div>
              {data.activity.length === 0 ? (
                <Empty
                  compact
                  icon={Clock}
                  title="Nothing yet"
                  body="Every console action is recorded here."
                />
              ) : (
                <ul className="feed">
                  {data.activity.map((e) => {
                    const d = describe(e, planMap);
                    const subject = subjectOf(e);
                    return (
                      <li className="feed__item" key={e.id}>
                        <span className={`feed__icon feed__icon--${d.tone}`}>
                          <d.icon size={14} aria-hidden />
                        </span>
                        <div className="feed__body">
                          <span className="feed__title">
                            {d.verb}{' '}
                            {subject &&
                              (e.tenant_id ? (
                                <Link to={`/tenants/${e.tenant_id}`}>{subject}</Link>
                              ) : (
                                <b>{subject}</b>
                              ))}
                          </span>
                          <span className="feed__meta">
                            {e.actor_label ?? 'System'} · {relative(e.created_at)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          {/* Plan mix and growth are for a monthly look, not a daily one. */}
          <details className="insights">
            <summary className="insights__toggle">Plans and growth</summary>
            <div className="grid">
              <section className="card span-6">
                <div className="card__head">
                  <div>
                    <h2>Revenue by plan</h2>
                    <p className="card__sub">Share of monthly recurring revenue</p>
                  </div>
                </div>
                <ShareBars
                  empty="No paying clinics yet."
                  rows={data.plans
                    .filter((p) => p.mrr > 0)
                    .sort((a, b) => b.mrr - a.mrr)
                    .map((p) => ({
                      key: p.id,
                      label: p.name,
                      value: p.mrr,
                      display: formatEuro(p.mrr),
                      note: `${p.paying_count} clinic${p.paying_count === 1 ? '' : 's'}`,
                    }))}
                />
              </section>

              <section className="card span-6">
                <div className="card__head card__head--flush">
                  <div>
                    <h2>New clinics</h2>
                    <p className="card__sub">Clinics set up each month</p>
                  </div>
                </div>
                <ColumnChart
                  columns={growth}
                  series={[{ name: 'New clinics', color: 'var(--data-1)' }]}
                  format={(n) => String(n)}
                  integer
                  height={200}
                  ariaLabel="New clinics set up each month, last six months"
                />
              </section>
            </div>
          </details>

          {data.tenants.length === 0 && (
            <section className="card" style={{ marginTop: 16 }}>
              <Empty
                icon={Building2}
                title="No clinics yet"
                body="Create the first clinic, or a seven-day demo for a sales call."
                action={
                  <>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => openCreate(true)}
                    >
                      New demo
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => openCreate(false)}
                    >
                      New clinic
                    </button>
                  </>
                }
              />
            </section>
          )}
        </>
      ) : (
        !error && (
          <div className="card">
            <SkeletonRows rows={6} />
          </div>
        )
      )}
    </div>
  );
}

/**
 * Everything on the fleet that wants a person, most urgent first: money that
 * is late, clinics about to lock, clinics already locked, a month nobody has
 * billed yet, and clinics that have stopped using the product.
 */
function needsAttention(d: Data): Attention[] {
  const out: Attention[] = [];

  for (const i of d.invoices) {
    if (i.status !== 'open' || !i.overdue) continue;
    out.push({
      key: `inv-${i.id}`,
      tone: 'danger',
      icon: ReceiptText,
      title: `${i.tenantName} owes ${formatEuro(i.amount)}`,
      sub: `${i.number} · ${i.daysLate} day${i.daysLate === 1 ? '' : 's'} late`,
      to: `/tenants/${i.tenantId}?tab=billing`,
      rank: 0 - i.daysLate / 1000,
    });
  }

  for (const t of d.tenants) {
    if (t.status !== 'active') continue;
    const trial = trialState(t.trial_ends_at);
    if (trial.kind === 'running' && trial.daysLeft <= TRIAL_SOON_DAYS) {
      out.push({
        key: `trial-${t.id}`,
        tone: 'warn',
        icon: Hourglass,
        title: `${t.name}: trial ends ${trial.daysLeft === 1 ? 'tomorrow' : `in ${trial.daysLeft} days`}`,
        sub: t.plan_name
          ? `Then ${t.plan_name} · ${formatEuro(t.price_monthly)}/mo`
          : 'No plan chosen yet',
        to: `/tenants/${t.id}`,
        rank: 1 + trial.daysLeft / 100,
      });
    } else if (trial.kind === 'expired') {
      out.push({
        key: `expired-${t.id}`,
        tone: 'danger',
        icon: CalendarClock,
        title: `${t.name} is read-only`,
        sub: `Trial ended ${trial.daysAgo === 0 ? 'today' : `${trial.daysAgo} days ago`} — convert or extend`,
        to: `/tenants/${t.id}`,
        rank: 0.5,
      });
    }
  }

  if (d.billing.unbilledClinics > 0) {
    const month = new Date().toLocaleDateString('en-GB', { month: 'long' });
    out.push({
      key: 'unbilled',
      tone: 'info',
      icon: ReceiptText,
      title: `${d.billing.unbilledClinics} clinic${d.billing.unbilledClinics === 1 ? '' : 's'} not billed for ${month}`,
      sub: 'Run this month’s billing',
      to: '/billing',
      rank: 2,
    });
  }

  for (const u of d.usage?.tenants ?? []) {
    if (u.status !== 'active') continue;
    const age = daysSince(u.createdAt) ?? 0;
    const quiet = daysSince(u.lastActivity);
    if (age < QUIET_DAYS) continue;
    if (quiet === null || quiet > QUIET_DAYS) {
      out.push({
        key: `quiet-${u.tenantId}`,
        tone: 'neutral',
        icon: Moon,
        title: `${u.name} has gone quiet`,
        sub:
          quiet === null ? 'No activity recorded yet' : `No activity for ${quiet} days`,
        to: `/tenants/${u.tenantId}`,
        rank: 3,
      });
    }
  }

  return out.sort((a, b) => a.rank - b.rank);
}
