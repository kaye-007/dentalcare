import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarPlus, UserPlus, ReceiptText, TrendingDown, ChevronRight, CalendarDays,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api, appointmentsApi, financeApi, type Appointment, type PatientListItem, type InvoiceSummaryRow, type FinanceSummary } from '../lib/api';
import { Avatar, StatusPill, EmptyState } from '../components/ui';
import { formatLek } from '../lib/format';

function todayLabel() {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}
function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function relDate(s: string) {
  const d = new Date(s);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function DashboardPage() {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const [todayAppts, setTodayAppts] = useState<Appointment[] | null>(null);
  const [patients, setPatients] = useState<{ total: number; recent: PatientListItem[] } | null>(null);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [openInvoices, setOpenInvoices] = useState<InvoiceSummaryRow[] | null>(null);

  useEffect(() => {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 1);
    appointmentsApi
      .list({ from: from.toISOString(), to: to.toISOString() })
      .then(setTodayAppts)
      .catch(() => setTodayAppts([]));
    api.listPatients({ status: 'active' })
      .then((d) => setPatients({ total: d.total, recent: d.items.slice(0, 6) }))
      .catch(() => setPatients({ total: 0, recent: [] }));
    financeApi.summary('month').then(setSummary).catch(() => setSummary(null));
    financeApi.listInvoices({})
      .then((rows) => setOpenInvoices(
        rows.filter((r) => r.status === 'unpaid' || r.status === 'partially_paid').slice(0, 4),
      ))
      .catch(() => setOpenInvoices([]));
  }, []);

  const scheduledToday = todayAppts?.filter((a) => a.status === 'scheduled').length ?? null;
  const completedToday = todayAppts?.filter((a) => a.status === 'completed').length ?? null;

  const quickActions = [
    { to: '/reservations', label: 'New appointment', icon: CalendarPlus, primary: true },
    { to: '/patients/new', label: 'Add patient', icon: UserPlus },
    { to: '/invoices', label: 'New invoice', icon: ReceiptText },
    { to: '/expenses', label: 'Add expense', icon: TrendingDown },
  ];

  return (
    <div className="page">
      <div className="page__lead">
        <p className="greeting">Good day, <strong>{user?.fullName}</strong> · {todayLabel()}</p>
      </div>

      {/* KPI row — live where modules exist, sample-tagged where not */}
      <section className="kpis">
        <article className="kpi">
          <div className="kpi__top"><span className="kpi__label">Today's appointments</span></div>
          <p className="kpi__value">{todayAppts === null ? '…' : todayAppts.length}</p>
          <div className="kpi__foot">
            <span className="kpi__caption">
              {scheduledToday === null ? '' : `${scheduledToday} scheduled · ${completedToday} done`}
            </span>
          </div>
        </article>
        <article className="kpi">
          <div className="kpi__top"><span className="kpi__label">Active patients</span></div>
          <p className="kpi__value">{patients === null ? '…' : patients.total}</p>
          <div className="kpi__foot"><span className="kpi__caption">across this clinic</span></div>
        </article>
        {isOwner ? (
          <>
            <article className="kpi">
              <div className="kpi__top"><span className="kpi__label">Collected this month</span></div>
              <p className="kpi__value">{summary === null ? '…' : formatLek(summary.totalCollected)}</p>
              <div className="kpi__foot">
                <span className="kpi__caption">
                  {summary === null ? '' : `${formatLek(summary.totalInvoiced)} invoiced`}
                </span>
              </div>
            </article>
            <article className="kpi">
              <div className="kpi__top"><span className="kpi__label">Profit this month</span></div>
              <p className="kpi__value">
                {summary === null ? '…' : formatLek(summary.totalCollected - summary.totalExpenses)}
              </p>
              <div className="kpi__foot">
                <span className="kpi__caption">
                  {summary === null ? 'collected − expenses' : `${formatLek(summary.totalExpenses)} expenses`}
                </span>
              </div>
            </article>
          </>
        ) : (
          <article className="kpi">
            <div className="kpi__top"><span className="kpi__label">Outstanding balance</span></div>
            <p className="kpi__value">{summary === null ? '…' : formatLek(summary.outstanding)}</p>
            <div className="kpi__foot">
              <span className="kpi__caption">{openInvoices === null ? '' : `${openInvoices.length} open invoice(s) shown`}</span>
            </div>
          </article>
        )}
      </section>

      <section className="grid">
        {/* Today's schedule — REAL data */}
        <div className="card span-8">
          <div className="card__head">
            <div>
              <h2>Today's schedule</h2>
              <p className="card__sub">{todayAppts?.length ?? 0} appointments</p>
            </div>
            <Link to="/reservations" className="link">Open calendar <ChevronRight size={15} /></Link>
          </div>
          {todayAppts && todayAppts.length === 0 ? (
            <EmptyState
              icon={<CalendarDays size={22} />}
              title="Nothing booked today"
              body="Open the calendar to book the first appointment of the day."
              action={<Link to="/reservations" className="btn btn--primary btn--sm">Open calendar</Link>}
            />
          ) : (
            <ul className="list">
              {(todayAppts ?? []).map((a) => (
                <li className="row" key={a.id}>
                  <span className="row__time">{fmtTime(a.startsAt)}</span>
                  <Avatar name={a.patientName} />
                  <span className="row__main">
                    <span className="row__title">{a.patientName}</span>
                    <span className="row__sub">{a.reason}</span>
                  </span>
                  <span className="row__side">{a.staffName ?? '—'}</span>
                  <StatusPill status={a.status} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Right rail */}
        <div className="rail span-4">
          <div className="card">
            <div className="card__head"><h2>Quick actions</h2></div>
            <div className="quick">
              {quickActions.map((q) => {
                const Icon = q.icon;
                return (
                  <Link key={q.to} to={q.to} className={`quick__btn${q.primary ? ' quick__btn--primary' : ''}`}>
                    <Icon size={17} /><span>{q.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div className="card__head">
              <div>
                <h2>Pending payments</h2>
                <p className="card__sub">
                  {summary === null ? '…' : `${formatLek(summary.outstanding)} outstanding`}
                </p>
              </div>
              <Link to="/invoices" className="link"><ChevronRight size={15} /></Link>
            </div>
            {openInvoices !== null && openInvoices.length === 0 ? (
              <p className="pad muted" style={{ fontSize: 13 }}>No unpaid invoices. Nice.</p>
            ) : (
              <ul className="list">
                {(openInvoices ?? []).map((p) => (
                  <li className="row" key={p.id}>
                    <Avatar name={p.patientName} size={30} />
                    <span className="row__main">
                      <span className="row__title">{p.patientName}</span>
                      <span className="row__sub">{p.invoiceNumber}</span>
                    </span>
                    <span className="row__amount">{formatLek(p.balance)}</span>
                    <StatusPill status={p.status} label={p.status === 'partially_paid' ? 'Partial' : undefined} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Recent patients — REAL data */}
        <div className="card span-12">
          <div className="card__head">
            <h2>Recent patients</h2>
            <Link to="/patients" className="link">View all <ChevronRight size={15} /></Link>
          </div>
          <div className="patients">
            {(patients?.recent ?? []).map((p) => (
              <Link to={`/patients/${p.id}`} className="patient" key={p.id}>
                <Avatar name={`${p.firstName} ${p.lastName}`} size={38} />
                <span className="patient__meta">
                  <span className="patient__name">{p.firstName} {p.lastName}</span>
                  <span className="patient__treat">{p.city ?? p.phone ?? '—'}</span>
                </span>
                <span className="patient__visit">{relDate(p.createdAt)}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
