import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  ChevronRight,
  ReceiptText,
  TrendingDown,
  TriangleAlert,
  UserPlus,
  Users,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import {
  api,
  appointmentsApi,
  financeApi,
  inventoryApi,
  type Appointment,
  type ApptStatus,
  type PatientListItem,
  type InvoiceSummaryRow,
  type FinanceSummary,
  type InventoryAlerts,
} from '../lib/api';
import { Avatar, StatusPill, EmptyState } from '../components/ui';
import GettingStarted, { type Progress } from '../components/GettingStarted';
import { t } from '../lib/strings';
import { formatMoney, plural } from '../lib/format';
import { dateLocale } from '../lib/strings';
import { useMinute } from '../lib/useMinute';

function todayLabel() {
  return new Date().toLocaleDateString(dateLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}
function monthLabel() {
  return new Date().toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' });
}
function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString(dateLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
}
function relDate(s: string) {
  const d = new Date(s);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
}
function greeting(hour: number) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Above this many patients, a clinic is past setup and the checklist goes. */
const SETUP_PATIENT_CEILING = 5;

export default function DashboardPage() {
  const { user, can, readOnly } = useAuth();
  const canAccess = can('reports:read');
  const canSeeStock = can('inventory:read');
  const [stock, setStock] = useState<InventoryAlerts | null>(null);

  const [todayAppts, setTodayAppts] = useState<Appointment[] | null>(null);
  const [patients, setPatients] = useState<{
    total: number;
    recent: PatientListItem[];
  } | null>(null);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [openInvoices, setOpenInvoices] = useState<InvoiceSummaryRow[] | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const now = useMinute();

  useEffect(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    appointmentsApi
      .list({ from: from.toISOString(), to: to.toISOString() })
      .then(setTodayAppts)
      .catch(() => setTodayAppts([]));
    // Advisory only. A stock outage must not take the dashboard with it, so
    // a failure here leaves the bar hidden rather than surfacing an error.
    if (canSeeStock) {
      inventoryApi
        .alerts()
        .then(setStock)
        .catch(() => setStock(null));
    }
    api
      .listPatients({ status: 'active' })
      .then(async (d) => {
        setPatients({ total: d.total, recent: d.items.slice(0, 6) });

        // The checklist is only for a clinic still setting up, and only then
        // is the appointment count worth a request. A clinic past five
        // patients is plainly using the thing; probing its whole calendar to
        // decide whether to show a card it will never see is pure cost.
        if (d.total > SETUP_PATIENT_CEILING) return;

        const year = 365 * 86_400_000;
        const [appts, invoices] = await Promise.all([
          appointmentsApi
            .list({
              from: new Date(Date.now() - year).toISOString(),
              to: new Date(Date.now() + year).toISOString(),
            })
            .catch(() => []),
          financeApi.listInvoices({}).catch(() => []),
        ]);
        setProgress({
          patients: d.total,
          appointments: appts.length,
          invoices: invoices.length,
        });
      })
      .catch(() => setPatients({ total: 0, recent: [] }));
    financeApi
      .summary('month')
      .then(setSummary)
      .catch(() => setSummary(null));
    financeApi
      .listInvoices({})
      .then((rows) =>
        setOpenInvoices(
          rows
            .filter((r) => r.status === 'unpaid' || r.status === 'partially_paid')
            .slice(0, 4),
        ),
      )
      .catch(() => setOpenInvoices([]));
  }, [canSeeStock]);

  const schedule = useMemo(
    () =>
      todayAppts
        ? [...todayAppts].sort(
            (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
          )
        : null,
    [todayAppts],
  );
  const countOf = (status: ApptStatus) =>
    todayAppts === null ? null : todayAppts.filter((a) => a.status === status).length;

  // The first patient still to be seen whose slot has not already ended.
  const nextId = schedule?.find(
    (a) =>
      (a.status === 'scheduled' || a.status === 'checked_in') &&
      new Date(a.endsAt).getTime() > now,
  )?.id;

  const quickActions = [
    { to: '/patients/new', label: t('quick.addPatient'), icon: UserPlus },
    { to: '/invoices', label: t('quick.newInvoice'), icon: ReceiptText },
    { to: '/expenses', label: t('quick.addExpense'), icon: TrendingDown },
  ];

  const money = (v: number | undefined) => (summary === null ? '…' : formatMoney(v ?? 0));
  const collected = summary?.totalCollected ?? 0;
  const invoiced = summary?.totalInvoiced ?? 0;
  const collectedPct = invoiced > 0 ? Math.min(100, Math.round((collected / invoiced) * 100)) : null;

  const dayStats: { label: string; value: number | null; dot?: string }[] = [
    { label: 'Appointments', value: todayAppts?.length ?? null },
    { label: 'Waiting', value: countOf('checked_in'), dot: 'info' },
    { label: 'In chair', value: countOf('in_progress'), dot: 'warn' },
    { label: 'Completed', value: countOf('completed'), dot: 'ok' },
  ];

  return (
    <div className="page">
      <header className="dash__head">
        <div>
          <p className="dash__date">{todayLabel()}</p>
          <h1 className="section-title">
            {greeting(new Date(now).getHours())}, {user?.fullName}
          </h1>
        </div>
        {/* Hidden once the trial expires, like every other create control:
            the booking form would only fail on save. */}
        {!readOnly && (
          <div className="page__actions">
            <Link to="/reservations?new=1" className="btn btn--primary">
              <CalendarPlus size={16} aria-hidden /> {t('quick.newAppointment')}
            </Link>
          </div>
        )}
      </header>

      {/* Hidden once the trial expires: every button on it would 402, and
          offering someone a control that cannot work is worse than offering
          none. The banner above already explains why. */}
      {progress && !readOnly && <GettingStarted progress={progress} />}

      {/* Stock that needs ordering. Shown to both roles: the person who
          notices the gloves are gone is the person at the front desk. */}
      {canSeeStock && stock && stock.lowCount > 0 && (
        <Link to="/inventory" className="alertbar">
          <TriangleAlert size={16} aria-hidden />
          <span>
            {stock.lowCount === 1
              ? t('inv.alerts.one')
              : t('inv.alerts.many', { count: stock.lowCount })}
          </span>
          <span className="alertbar__items">
            {stock.items
              .slice(0, 3)
              .map((i) => i.name)
              .join(' · ')}
            {stock.items.length > 3 ? ' …' : ''}
          </span>
          <span className="alertbar__go">{t('inv.alerts.view')}</span>
        </Link>
      )}

      {/* Lots close to or past their date, and recalled stock still on the
          shelf. Recalled lots lead: they are the ones that must not reach a
          patient. */}
      {canSeeStock && stock && stock.expiringLots.length + stock.recalledLots.length > 0 && (
        <Link to="/inventory" className="alertbar">
          <CalendarClock size={16} aria-hidden />
          <span>
            {[
              stock.recalledLots.length > 0
                ? `${t('inv.badge.recalled')}: ${stock.recalledLots.length}`
                : null,
              stock.expiringCount === 1
                ? t('inv.expiry.one')
                : stock.expiringCount > 1
                  ? t('inv.expiry.many', { count: stock.expiringCount })
                  : null,
              stock.expiredCount > 0
                ? t('inv.expiry.expired', { count: stock.expiredCount })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="alertbar__items">
            {[...stock.recalledLots, ...stock.expiringLots]
              .slice(0, 3)
              .map((l) => `${l.itemName} ${l.lotNumber}`)
              .join(' · ')}
          </span>
          <span className="alertbar__go">{t('inv.alerts.view')}</span>
        </Link>
      )}

      <div className="grid">
        {/* Today's schedule */}
        <section className="card span-8" aria-labelledby="dash-schedule">
          <div className="card__head">
            <div>
              <h2 id="dash-schedule">Today's schedule</h2>
              <p className="card__sub">
                {todayAppts === null
                  ? 'Loading…'
                  : `${plural(todayAppts.length, 'appointment')} · ${countOf('scheduled')} still to arrive`}
              </p>
            </div>
            <Link to="/reservations" className="link">
              Open calendar <ChevronRight size={15} aria-hidden />
            </Link>
          </div>

          <div className="daystats">
            {dayStats.map((s) => (
              <div className="daystat" key={s.label}>
                <span className="daystat__value">{s.value ?? '…'}</span>
                <span className="daystat__label">
                  {s.dot && <span className={`daystat__dot daystat__dot--${s.dot}`} aria-hidden />}
                  {s.label}
                </span>
              </div>
            ))}
          </div>

          {schedule === null ? (
            <p className="pad muted">Loading today's schedule…</p>
          ) : schedule.length === 0 ? (
            <EmptyState
              icon={<CalendarDays size={22} />}
              title="Nothing booked today"
              body="Open the calendar to book the first appointment of the day."
              action={
                <Link to="/reservations" className="btn btn--ghost btn--sm">
                  Open calendar
                </Link>
              }
            />
          ) : (
            <ol className="agenda">
              {schedule.map((a) => {
                const isNext = a.id === nextId;
                return (
                  <li
                    key={a.id}
                    className={`agenda__item agenda__item--${a.status}${
                      isNext ? ' agenda__item--next' : ''
                    }`}
                  >
                    <span className="agenda__time">
                      <span className="agenda__start">{fmtTime(a.startsAt)}</span>
                      <span className="agenda__end">{fmtTime(a.endsAt)}</span>
                    </span>
                    <span
                      className="agenda__rail"
                      style={a.operatoryColor ? { background: a.operatoryColor } : undefined}
                      aria-hidden
                    />
                    <span className="agenda__main">
                      <Link to={`/patients/${a.patientId}`} className="agenda__patient">
                        {a.patientName}
                      </Link>
                      <span className="agenda__meta">
                        {a.reason}
                        {a.staffName ? ` · ${a.staffName}` : ''}
                        {a.operatoryName ? ` · ${a.operatoryName}` : ''}
                      </span>
                    </span>
                    <span className="agenda__side">
                      {isNext && <span className="agenda__next">Next</span>}
                      <StatusPill status={a.status} />
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* Right rail */}
        <div className="rail span-4">
          <section className="card" aria-labelledby="dash-quick">
            <div className="card__head">
              <h2 id="dash-quick">{t('quick.title')}</h2>
            </div>
            {readOnly ? (
              // Every one of these leads to a form that would 402 on save.
              // Walking someone through filling it in first is a worse
              // experience than telling them plainly up front.
              <p className="quick__paused">{t('quick.paused')}</p>
            ) : (
              <div className="quick">
                {quickActions.map((q) => {
                  const Icon = q.icon;
                  return (
                    <Link key={q.to} to={q.to} className="quick__btn">
                      <span className="quick__icon" aria-hidden>
                        <Icon size={16} />
                      </span>
                      <span>{q.label}</span>
                      <ChevronRight className="quick__go" size={16} aria-hidden />
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          {canAccess && (
            <section className="card" aria-labelledby="dash-money">
              <div className="card__head">
                <div>
                  <h2 id="dash-money">This month</h2>
                  <p className="card__sub">{monthLabel()}</p>
                </div>
                <Link to="/financials" className="link">
                  {t('nav.financials')} <ChevronRight size={15} aria-hidden />
                </Link>
              </div>
              <div className="money">
                <div>
                  <span className="money__label">Collected</span>
                  <strong className="money__value">{money(summary?.totalCollected)}</strong>
                  {collectedPct !== null && (
                    <>
                      <div className="meter" aria-hidden>
                        <span className="meter__fill" style={{ width: `${collectedPct}%` }} />
                      </div>
                      <p className="meter__caption">
                        {collectedPct}% of {formatMoney(invoiced)} invoiced
                      </p>
                    </>
                  )}
                </div>
                <dl className="money__rows">
                  <div className="money__row">
                    <dt>Invoiced</dt>
                    <dd>{money(summary?.totalInvoiced)}</dd>
                  </div>
                  <div className="money__row">
                    <dt>Expenses</dt>
                    <dd>{money(summary?.totalExpenses)}</dd>
                  </div>
                  {/* A month in the red is the one number on this card that
                      should stop the reader, so it is the one that changes
                      colour. Everything else stays ink. */}
                  <div className="money__row money__row--strong">
                    <dt>Profit</dt>
                    <dd
                      className={
                        summary && (summary.totalCollected ?? 0) - (summary.totalExpenses ?? 0) < 0
                          ? 'money__negative'
                          : undefined
                      }
                    >
                      {summary === null
                        ? '…'
                        : formatMoney(
                            (summary.totalCollected ?? 0) - (summary.totalExpenses ?? 0),
                          )}
                    </dd>
                  </div>
                </dl>
              </div>
            </section>
          )}

          <section className="card" aria-labelledby="dash-owed">
            <div className="card__head">
              <div>
                <h2 id="dash-owed">Awaiting payment</h2>
                <p className="card__sub">
                  {summary === null
                    ? '…'
                    : `${formatMoney(summary.outstanding)} outstanding`}
                </p>
              </div>
              <Link to="/invoices" className="link" aria-label="All invoices">
                {t('nav.invoices')} <ChevronRight size={15} aria-hidden />
              </Link>
            </div>
            {openInvoices === null ? (
              <p className="pad muted">Loading…</p>
            ) : openInvoices.length === 0 ? (
              <p className="pad muted">No unpaid invoices. Nice.</p>
            ) : (
              <ul className="list">
                {openInvoices.map((p) => (
                  <li className="row" key={p.id}>
                    <Avatar name={p.patientName} size={32} />
                    <span className="row__main">
                      <Link to={`/invoices/${p.id}`} className="row__title row__link">
                        {p.patientName}
                      </Link>
                      <span className="row__sub">{p.invoiceNumber}</span>
                    </span>
                    <span className="row__amount">{formatMoney(p.balance)}</span>
                    <StatusPill status={p.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Recent patients */}
        <section className="card span-12" aria-labelledby="dash-patients">
          <div className="card__head">
            <div>
              <h2 id="dash-patients">Recent patients</h2>
              <p className="card__sub">
                {patients === null ? '…' : `${plural(patients.total, 'active patient')}`}
              </p>
            </div>
            <Link to="/patients" className="link">
              View all <ChevronRight size={15} aria-hidden />
            </Link>
          </div>
          {patients !== null && patients.recent.length === 0 ? (
            <EmptyState
              icon={<Users size={22} />}
              title="No patients yet"
              body="Start with a name and a phone number — everything else can be filled in later."
              action={
                !readOnly ? (
                  <Link to="/patients/new" className="btn btn--ghost btn--sm">
                    <UserPlus size={15} aria-hidden /> {t('quick.addPatient')}
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <div className="patients">
              {(patients?.recent ?? []).map((p) => (
                <Link to={`/patients/${p.id}`} className="patient" key={p.id}>
                  <Avatar name={`${p.firstName} ${p.lastName}`} size={38} />
                  <span className="patient__meta">
                    <span className="patient__name">
                      {p.firstName} {p.lastName}
                    </span>
                    <span className="patient__treat">{p.city ?? p.phone ?? '—'}</span>
                  </span>
                  <span className="patient__visit">{relDate(p.createdAt)}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
