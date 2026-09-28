import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays,
  CalendarPlus,
  ChevronRight,
  FlaskConical,
  Landmark,
  LogIn,
  Phone,
  ReceiptText,
  RotateCcw,
  Stethoscope,
  TriangleAlert,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import {
  api,
  appointmentsApi,
  billingApi,
  drawerApi,
  fiscalApi,
  labApi,
  humanError,
  financeApi,
  inventoryApi,
  type Appointment,
  type DrawerCurrent,
  type ApptStatus,
  type InvoiceSummaryRow,
  type FinanceSummary,
  type InventoryAlerts,
  type FiscalQueue,
  type LabSummary,
} from '../lib/api';
import {
  Avatar,
  StatusPill,
  EmptyState,
  LoadingRows,
  Skeleton,
  useToast,
} from '../components/ui';
import GettingStarted, { type Progress } from '../components/GettingStarted';
import { t } from '../lib/strings';
import { formatMoney, plural } from '../lib/format';
import { dateLocale } from '../lib/strings';
import {
  fromWall,
  inClinicZone,
  toWall,
  toWallString,
  wallNow,
} from '../lib/clinic-time';
import { useMinute } from '../lib/useMinute';
import { isPractitioner } from '../lib/permissions';
import { useFeatures } from '../lib/features';
import { useIsPhone, useMedia } from '../lib/useIsPhone';
import { useBooking } from '../lib/booking';
import WaitingPill from '../components/WaitingPill';

/** Today on the clinic's clock, which is not always the browser's. */
function todayLabel() {
  return wallNow().toLocaleDateString(dateLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}
function monthLabel() {
  return new Date().toLocaleDateString(
    dateLocale(),
    inClinicZone({ month: 'long', year: 'numeric' }),
  );
}
function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString(
    dateLocale(),
    inClinicZone({
      hour: '2-digit',
      minute: '2-digit',
    }),
  );
}
function greeting(hour: number) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
/** "Dr. Arben Hoxha" → "Arben": a greeting uses the name, not the title. */
function firstName(full: string | undefined) {
  const words = (full ?? '').trim().split(/\s+/);
  return words.find((w) => !/^(dr|prof|mr|mrs|ms|dott)\.?$/i.test(w)) ?? words[0] ?? '';
}

/** Above this many patients, a clinic is past setup and the checklist goes. */
const SETUP_PATIENT_CEILING = 5;

/**
 * Who is looking decides what the dashboard is for.
 *
 *   desk       reception and assistants — today's flow: who is due, who is
 *              waiting, who still owes
 *   clinician  dentists and hygienists — their own patients today
 *   owner      the administrator — today at a glance, then the month's money
 *   books      the accountant — money only; they never see patient records
 *
 * Each role gets one primary action and nothing it cannot act on.
 */
type Lens = 'desk' | 'clinician' | 'owner' | 'books';

export default function DashboardPage() {
  const { user, can, readOnly } = useAuth();
  const canSchedule = can('appointments:read');
  const canMoney = can('reports:read');
  const canInvoices = can('invoices:read');
  const canSeeStock = can('inventory:read');
  const lens: Lens = !canSchedule
    ? 'books'
    : user?.role === 'admin'
      ? 'owner'
      : isPractitioner(user?.role)
        ? 'clinician'
        : 'desk';

  const [stock, setStock] = useState<InventoryAlerts | null>(null);
  const [todayAppts, setTodayAppts] = useState<Appointment[] | null>(null);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  // The owner's "today": takings so far, and where the cash drawer stands.
  const [todayMoney, setTodayMoney] = useState<FinanceSummary | null>(null);
  const [drawer, setDrawer] = useState<DrawerCurrent | null | undefined>(undefined);
  const { enabled, features } = useFeatures();
  const featuresLoading = features === null;
  const [openInvoices, setOpenInvoices] = useState<InvoiceSummaryRow[] | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  // The next seven days after today: what the desk confirms by phone.
  const [upcoming, setUpcoming] = useState<Appointment[] | null>(null);
  const [checkingIn, setCheckingIn] = useState<string | null>(null);
  // A phone shows what is still to happen; finished visits fold into one line.
  const phone = useIsPhone();
  const [showFinished, setShowFinished] = useState(false);
  // Where the page is one column (styles.css stacks the rail at 1080px), the
  // owner's month and open invoices follow the day's figures, not every visit.
  const oneColumn = useMedia('(max-width: 1080px)');
  const moneyFirst = oneColumn && lens === 'owner';
  // How many patients are due back for a check-up (six months, nothing booked).
  const [recallDue, setRecallDue] = useState<number | null>(null);
  // The rest of what can need someone today: lab work that is late or back to
  // fit, invoices the tax authority refused or is about to miss, and money
  // that has been owed for over two months.
  const [labSum, setLabSum] = useState<LabSummary | null>(null);
  const [fiscal, setFiscal] = useState<FiscalQueue['counts'] | null>(null);
  const [aged, setAged] = useState<{ count: number; amount: number } | null>(null);
  const [billedToday, setBilledToday] = useState<Set<string>>(new Set());
  const toast = useToast();
  const openBooking = useBooking();
  const now = useMinute();
  const canMove = can('appointments:write') && !readOnly;
  const canBill = can('invoices:write') && !readOnly;

  const loadToday = useCallback(() => {
    if (!canSchedule) return;
    // Today is the clinic's today, midnight to midnight on its clock.
    const from = wallNow();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    appointmentsApi
      .list({ from: fromWall(from).toISOString(), to: fromWall(to).toISOString() })
      .then(setTodayAppts)
      .catch(() => setTodayAppts([]));
  }, [canSchedule]);

  async function checkIn(a: Appointment) {
    setCheckingIn(a.id);
    try {
      await appointmentsApi.transition(a.id, 'checked_in');
      // Checking in the wrong namesake is one tap to put right.
      toast(`${a.patientName} is checked in.`, {
        action: {
          label: 'Undo',
          run: async () => {
            try {
              await appointmentsApi.transition(a.id, 'scheduled');
              toast(`${a.patientName} is no longer checked in.`);
            } catch (err) {
              toast(humanError(err, 'The check-in could not be undone.'), 'error');
            }
            loadToday();
          },
        },
      });
      loadToday();
    } catch (err) {
      toast(humanError(err, 'The check-in did not go through. Try again.'), 'error');
    } finally {
      setCheckingIn(null);
    }
  }

  useEffect(() => {
    loadToday();
    if (canSchedule && lens !== 'clinician') {
      const from = wallNow();
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() + 1);
      const to = new Date(from);
      to.setDate(to.getDate() + 7);
      appointmentsApi
        .list({ from: fromWall(from).toISOString(), to: fromWall(to).toISOString() })
        .then((l) => setUpcoming(l.filter((a) => a.status !== 'cancelled')))
        .catch(() => setUpcoming([]));
    }
    if (canSchedule && can('patients:read') && (lens === 'desk' || lens === 'owner')) {
      api
        .recallDue(6)
        .then((r) => setRecallDue(r.items.length))
        .catch(() => setRecallDue(null));
    }
    if (can('lab:read')) {
      labApi
        .summary()
        .then(setLabSum)
        .catch(() => setLabSum(null));
    }
    if (lens !== 'clinician' && can('fiscal:read')) {
      fiscalApi
        .queue()
        .then((q) => setFiscal(q.counts))
        .catch(() => setFiscal(null));
    }
    if (lens === 'owner' && canInvoices) {
      billingApi
        .receivables()
        .then((r) => {
          const old = r.buckets.filter((b) => b.key === 'd61_90' || b.key === 'over_90');
          setAged({
            count: old.reduce((s, b) => s + b.count, 0),
            amount: old.reduce((s, b) => s + b.amount, 0),
          });
        })
        .catch(() => setAged(null));
    }
    // Advisory only. A stock outage must not take the dashboard with it.
    if (canSeeStock) {
      inventoryApi
        .alerts()
        .then(setStock)
        .catch(() => setStock(null));
    }
    // The first-run checklist is the owner's: only they can finish all of it.
    if (lens === 'owner') {
      api
        .listPatients({ status: 'active' })
        .then(async (d) => {
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
        .catch(() => undefined);
    }
    if (canMoney) {
      financeApi
        .summary('month')
        .then(setSummary)
        .catch(() => setSummary(null));
      if (lens === 'owner') {
        financeApi
          .summary('today')
          .then(setTodayMoney)
          .catch(() => setTodayMoney(null));
      }
    }
    if (canInvoices && lens !== 'clinician') {
      financeApi
        .listInvoices({})
        .then((rows) => {
          setOpenInvoices(
            rows
              .filter((r) => r.status === 'unpaid' || r.status === 'partially_paid')
              .slice(0, 5),
          );
          // Who was already billed today, so "Bill" is not offered twice.
          const today = toWallString(new Date().toISOString()).slice(0, 10);
          setBilledToday(
            new Set(
              rows
                // issuedAt is a calendar date ("2026-09-25"), compared as is.
                .filter(
                  (r) => r.status !== 'cancelled' && r.issuedAt.slice(0, 10) === today,
                )
                .map((r) => r.patientId),
            ),
          );
        })
        .catch(() => setOpenInvoices([]));
    }
  }, [loadToday, canSchedule, canSeeStock, canMoney, canInvoices, lens, can]);

  // Where the drawer stands, for the owner's strip. Only where the clinic
  // uses the drawer and the owner may operate it; otherwise the tile is left
  // out rather than showing a figure that means nothing.
  const showDrawer =
    lens === 'owner' &&
    !featuresLoading &&
    enabled('cash_drawer') &&
    can('drawer:operate');
  useEffect(() => {
    if (!showDrawer) return;
    drawerApi
      .current()
      .then(setDrawer)
      .catch(() => setDrawer(null));
  }, [showDrawer]);

  // A clinician sees their own column when they have one today.
  const schedule = useMemo(() => {
    if (!todayAppts) return null;
    const sorted = [...todayAppts].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
    if (lens !== 'clinician' || !user) return sorted;
    const mine = sorted.filter((a) => a.staffId === user.id);
    return mine.length > 0 ? mine : sorted;
  }, [todayAppts, lens, user]);
  const onlyMine =
    lens === 'clinician' && Boolean(schedule?.some((a) => a.staffId === user?.id));

  // Finished and nothing left to do: cancelled, or completed and billed (or
  // not this person's to bill). A completed visit still owing a bill stays.
  const isFinished = (a: Appointment) =>
    a.status === 'cancelled' ||
    (a.status === 'completed' &&
      (lens === 'clinician' || !canBill || billedToday.has(a.patientId)));
  const finishedCount = schedule?.filter(isFinished).length ?? 0;

  const countOf = (status: ApptStatus) =>
    schedule === null ? null : schedule.filter((a) => a.status === status).length;

  // The first patient still to be seen whose slot has not already ended.
  const next = schedule?.find(
    (a) =>
      (a.status === 'scheduled' || a.status === 'checked_in') &&
      new Date(a.endsAt).getTime() > now,
  );

  const primary =
    readOnly || lens === 'books' ? null : lens === 'clinician' ? (
      <Link to="/clinical" className="btn btn--primary">
        <Stethoscope size={16} aria-hidden /> Today’s patients
      </Link>
    ) : can('appointments:write') ? (
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => openBooking({ onSaved: loadToday })}
      >
        <CalendarPlus size={16} aria-hidden /> {t('quick.newAppointment')}
      </button>
    ) : null;

  const stockLine =
    canSeeStock && stock
      ? [
          stock.recalledLots.length > 0
            ? `${t('inv.badge.recalled')}: ${stock.recalledLots.length}`
            : null,
          stock.lowCount === 1
            ? t('inv.alerts.one')
            : stock.lowCount > 1
              ? t('inv.alerts.many', { count: stock.lowCount })
              : null,
          stock.expiringCount === 1
            ? t('inv.expiry.one')
            : stock.expiringCount > 1
              ? t('inv.expiry.many', { count: stock.expiringCount })
              : null,
          stock.expiredCount > 0
            ? t('inv.expiry.expired', { count: stock.expiredCount })
            : null,
        ].filter(Boolean)
      : [];

  const rail = (
    <div className="rail span-4">
      {lens === 'owner' && <MoneyCard summary={summary} canMoney={canMoney} />}
      {lens !== 'clinician' && canInvoices && (
        <OwedCard rows={openInvoices} summary={summary} />
      )}
      {lens === 'clinician' && <DayCounts schedule={schedule} />}
    </div>
  );

  return (
    <div className="page">
      <header className="dash__head">
        <div>
          <p className="dash__date">{todayLabel()}</p>
          <h1 className="section-title">
            {greeting(toWall(now).getHours())}, {firstName(user?.fullName)}
          </h1>
        </div>
        {primary && <div className="page__actions">{primary}</div>}
      </header>

      {progress && !readOnly && <GettingStarted progress={progress} />}

      {lens === 'owner' && (
        <TodayStrip
          schedule={schedule}
          today={canMoney ? todayMoney : undefined}
          outstanding={canMoney ? summary?.outstanding : undefined}
          drawer={showDrawer ? drawer : undefined}
        />
      )}

      {/* The exceptions, together and near the top — only when there are any.
          A clinician sees only their own kind: lab work late or back to fit. */}
      <NeedsAttention
        items={[
          ...(fiscal && fiscal.rejected + fiscal.urgent + fiscal.overdue > 0
            ? [
                {
                  key: 'fiscal',
                  icon: <Landmark size={16} aria-hidden />,
                  text: [
                    fiscal.rejected
                      ? `${plural(fiscal.rejected, 'invoice')} refused by the tax authority`
                      : null,
                    fiscal.urgent + fiscal.overdue
                      ? `${plural(fiscal.urgent + fiscal.overdue, 'fiscal invoice')} near or past the 48-hour limit`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  to: '/fiscal-queue',
                  go: 'Review',
                },
              ]
            : []),
          ...(labSum && labSum.overdue + labSum.ready > 0
            ? [
                {
                  key: 'lab',
                  icon: <FlaskConical size={16} aria-hidden />,
                  text: [
                    labSum.overdue ? `${plural(labSum.overdue, 'lab job')} late` : null,
                    labSum.ready ? `${labSum.ready} back from the lab, to fit` : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  to: '/lab',
                  go: 'Lab work',
                },
              ]
            : []),
          ...(aged && aged.count > 0
            ? [
                {
                  key: 'aged',
                  icon: <ReceiptText size={16} aria-hidden />,
                  text: `${plural(aged.count, 'invoice')} unpaid for over 60 days · ${formatMoney(aged.amount)}`,
                  to: canMoney ? '/financials' : '/invoices',
                  go: 'Review',
                },
              ]
            : []),
          ...(lens !== 'clinician' && stockLine.length > 0
            ? [
                {
                  key: 'stock',
                  icon: <TriangleAlert size={16} aria-hidden />,
                  text: stockLine.join(' · '),
                  to: '/inventory',
                  go: t('inv.alerts.view'),
                },
              ]
            : []),
          ...(lens !== 'clinician' && recallDue !== null && recallDue > 0
            ? [
                {
                  key: 'recall',
                  icon: <RotateCcw size={16} aria-hidden />,
                  text: `${plural(recallDue, 'patient')} due for a check-up, with nothing booked`,
                  to: '/patients/recall',
                  go: 'Review',
                },
              ]
            : []),
        ]}
      />

      {lens === 'books' ? (
        <div className="grid">
          <MoneyCard summary={summary} canMoney={canMoney} className="span-6" />
          {canInvoices && (
            <OwedCard rows={openInvoices} summary={summary} className="span-6" />
          )}
        </div>
      ) : (
        <div className="grid">
          {moneyFirst && rail}
          <div className="stack span-8">
            <section className="card" aria-labelledby="dash-schedule">
              <div className="card__head">
                <div>
                  <h2 id="dash-schedule">{onlyMine ? 'Your patients today' : 'Today'}</h2>
                  <p className="card__sub">
                    {schedule === null
                      ? 'Loading…'
                      : schedule.length === 0
                        ? 'Nothing booked'
                        : [
                            plural(schedule.length, 'appointment'),
                            countOf('checked_in')
                              ? `${countOf('checked_in')} waiting`
                              : null,
                            countOf('in_progress')
                              ? `${countOf('in_progress')} in the chair`
                              : null,
                            `${countOf('scheduled')} still to arrive`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                  </p>
                </div>
                <Link
                  to={lens === 'clinician' ? '/clinical' : '/reservations'}
                  className="link"
                >
                  {lens === 'clinician' ? 'Clinical view' : 'Open calendar'}{' '}
                  <ChevronRight size={15} aria-hidden />
                </Link>
              </div>

              {schedule === null ? (
                <LoadingRows rows={4} label="Loading today’s schedule" />
              ) : schedule.length === 0 ? (
                <EmptyState
                  icon={<CalendarDays size={22} />}
                  title="Nothing booked today"
                  body={
                    lens === 'clinician'
                      ? 'A quiet day. New bookings for you will show up here.'
                      : 'Book the first appointment of the day from the calendar.'
                  }
                  action={
                    lens !== 'clinician' && can('appointments:write') && !readOnly ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => openBooking({ onSaved: loadToday })}
                      >
                        <CalendarPlus size={15} aria-hidden /> Book appointment
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <ol className="agenda">
                  {(phone && !showFinished
                    ? schedule.filter((a) => !isFinished(a))
                    : schedule
                  ).map((a) => {
                    const isNext = a.id === next?.id;
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
                          style={
                            a.operatoryColor
                              ? { background: a.operatoryColor }
                              : undefined
                          }
                          aria-hidden
                        />
                        <span className="agenda__main">
                          <Link
                            to={`/patients/${a.patientId}${lens === 'clinician' ? '?tab=chart' : ''}`}
                            className="agenda__patient"
                          >
                            {a.patientName}
                          </Link>
                          <span className="agenda__meta">
                            {a.reason}
                            {a.staffName && !onlyMine ? ` · ${a.staffName}` : ''}
                            {a.operatoryName ? ` · ${a.operatoryName}` : ''}
                          </span>
                        </span>
                        <span className="agenda__side">
                          {/* The desk's two most frequent taps, right on the row. */}
                          {lens !== 'clinician' && a.patientPhone && (
                            <a
                              href={`tel:${a.patientPhone.replace(/\s+/g, '')}`}
                              className="iconbtn agenda__call"
                              aria-label={`Call ${a.patientName}`}
                              title={a.patientPhone}
                            >
                              <Phone size={15} aria-hidden />
                            </a>
                          )}
                          {lens !== 'clinician' &&
                          canBill &&
                          !billedToday.has(a.patientId) &&
                          (a.status === 'completed' || a.status === 'in_progress') ? (
                            <Link
                              to={`/invoices?new=1&patient=${encodeURIComponent(a.patientId)}&name=${encodeURIComponent(a.patientName)}`}
                              className="btn btn--ghost btn--sm agenda__checkin"
                            >
                              <ReceiptText size={14} aria-hidden /> Bill
                            </Link>
                          ) : lens !== 'clinician' &&
                            canMove &&
                            a.status === 'scheduled' ? (
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm agenda__checkin"
                              disabled={checkingIn === a.id}
                              onClick={() => void checkIn(a)}
                            >
                              <LogIn size={14} aria-hidden />
                              {checkingIn === a.id ? 'Checking in…' : 'Check in'}
                            </button>
                          ) : a.status === 'checked_in' && a.checkedInAt ? (
                            // Who is in the waiting room, and for how long:
                            // the desk's cue to tell the dentist, or to apologise.
                            <WaitingPill since={a.checkedInAt} />
                          ) : a.status !== 'scheduled' ? (
                            // "Scheduled" is what the time already says; a
                            // pill is kept for the states that need an eye.
                            <StatusPill status={a.status} />
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
              {phone && finishedCount > 0 && (
                <button
                  type="button"
                  className="btn btn--quiet btn--sm comingup__more"
                  aria-expanded={showFinished}
                  onClick={() => setShowFinished((v) => !v)}
                >
                  {showFinished
                    ? 'Hide finished visits'
                    : `Show ${plural(finishedCount, 'finished visit')}`}
                </button>
              )}
            </section>
            {lens !== 'clinician' && <ComingUp appts={upcoming} />}
          </div>

          {!moneyFirst && rail}
        </div>
      )}
    </div>
  );
}

/**
 * The days after today. A strip of the next seven days — how full each one is,
 * one tap to open it — and tomorrow's patients with a call button, because
 * confirming tomorrow by phone is the desk's standing afternoon job.
 */
function ComingUp({ appts }: { appts: Appointment[] | null }) {
  const days = useMemo(() => {
    const start = wallNow();
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i + 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { d, key, count: 0 };
    });
  }, []);
  const dayKey = (iso: string) => {
    const d = toWall(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const counted = days.map((x) => ({
    ...x,
    count: (appts ?? []).filter((a) => dayKey(a.startsAt) === x.key).length,
  }));
  const tomorrow = counted[0]!;
  const tomorrowList = (appts ?? [])
    .filter((a) => dayKey(a.startsAt) === tomorrow.key)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const max = Math.max(1, ...counted.map((x) => x.count));
  // Tomorrow's first few are the calls to make now; the rest are one tap away.
  const [allTomorrow, setAllTomorrow] = useState(false);
  const TOMORROW_SHOWN = 5;
  const shownTomorrow = allTomorrow
    ? tomorrowList
    : tomorrowList.slice(0, TOMORROW_SHOWN);

  return (
    <section className="card" aria-labelledby="dash-coming">
      <div className="card__head">
        <div>
          <h2 id="dash-coming">Coming up</h2>
          <p className="card__sub">
            {appts === null
              ? 'Loading…'
              : `${plural(appts.length, 'appointment')} in the next 7 days`}
          </p>
        </div>
        <Link to="/reservations" className="link">
          Calendar <ChevronRight size={15} aria-hidden />
        </Link>
      </div>

      <ol className="weekstrip" aria-label="Bookings per day">
        {counted.map((x) => (
          <li key={x.key}>
            <Link
              to={`/reservations?date=${x.key}`}
              className="weekstrip__day"
              aria-label={`${x.d.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}: ${plural(x.count, 'appointment')}`}
            >
              <span className="weekstrip__name">
                {x.d.toLocaleDateString(dateLocale(), { weekday: 'short' })}
              </span>
              <span className="weekstrip__num">{x.d.getDate()}</span>
              <span className="weekstrip__bar" aria-hidden>
                <span style={{ height: `${Math.round((x.count / max) * 100)}%` }} />
              </span>
              <span className="weekstrip__count">{appts === null ? '·' : x.count}</span>
            </Link>
          </li>
        ))}
      </ol>

      <h3 className="timeline__heading">Tomorrow</h3>
      {appts === null ? (
        <LoadingRows rows={2} label="Loading tomorrow" />
      ) : tomorrowList.length === 0 ? (
        <p className="dash__calm">Nothing booked for tomorrow yet.</p>
      ) : (
        <ul className="list">
          {shownTomorrow.map((a) => (
            <li className="row" key={a.id}>
              <span className="comingup__time">{fmtTime(a.startsAt)}</span>
              <span className="row__main">
                <Link to={`/patients/${a.patientId}`} className="row__title row__link">
                  {a.patientName}
                </Link>
                <span className="row__sub">
                  {a.reason}
                  {a.staffName ? ` · ${a.staffName}` : ''}
                </span>
              </span>
              {a.patientPhone && (
                <a
                  href={`tel:${a.patientPhone.replace(/\s+/g, '')}`}
                  className="btn btn--ghost btn--sm"
                  aria-label={`Call ${a.patientName} on ${a.patientPhone}`}
                >
                  <Phone size={14} aria-hidden /> Call
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {tomorrowList.length > TOMORROW_SHOWN && (
        <button
          type="button"
          className="btn btn--quiet btn--sm comingup__more"
          aria-expanded={allTomorrow}
          onClick={() => setAllTomorrow((v) => !v)}
        >
          {allTomorrow ? 'Show fewer' : `Show all ${tomorrowList.length} for tomorrow`}
        </button>
      )}
    </section>
  );
}

/**
 * What needs someone's attention today, in one place: stock, recall — the
 * exceptions. Nothing renders when there is nothing to do.
 */
function NeedsAttention({
  items,
}: {
  items: { key: string; icon: ReactNode; text: string; to: string; go: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="card attention" aria-label="Needs attention">
      <ul>
        {items.map((it) => (
          <li key={it.key}>
            <Link to={it.to} className="attention__row">
              {it.icon}
              <span className="attention__text">{it.text}</span>
              <span className="attention__go">
                {it.go} <ChevronRight size={15} aria-hidden />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The owner's first read of the day: how busy, what came in, what is still
 * owed, and whether the cash adds up. Four figures, no chart. Detail lives
 * one tap further in (the calendar, Overview, invoices, the drawer).
 */
function TodayStrip({
  schedule,
  today,
  outstanding,
  drawer,
}: {
  schedule: Appointment[] | null;
  /** undefined: not allowed to see money. null: still loading or failed. */
  today: FinanceSummary | null | undefined;
  outstanding: number | undefined;
  drawer: DrawerCurrent | null | undefined;
}) {
  const booked = schedule?.filter((a) => a.status !== 'cancelled') ?? null;
  const done = booked?.filter((a) => a.status === 'completed').length ?? 0;
  const session = drawer?.session ?? null;
  const expected = session?.expected?.[drawer?.currency ?? 'ALL'];
  const drawerTile = !drawer
    ? null
    : !session
      ? { value: 'Not started', note: 'Start the day at the drawer' }
      : session.status === 'open'
        ? {
            value: expected === undefined ? 'Open' : formatMoney(expected),
            note: `Expected cash · ${plural(session.cashPayments, 'cash payment')}`,
          }
        : session.status === 'counting'
          ? { value: 'Counting', note: 'The day is being closed' }
          : { value: 'Needs approval', note: 'A difference waits for a manager' };

  const tiles: {
    key: string;
    label: string;
    value: string | null;
    note?: string;
    to: string;
  }[] = [
    {
      key: 'appts',
      label: 'Appointments',
      value: booked === null ? null : String(booked.length),
      note: booked && booked.length > 0 ? `${done} done` : undefined,
      to: '/reservations',
    },
  ];
  if (today !== undefined) {
    // What was billed and what went out beside what came in, so the tile
    // answers "how did today go" without two more tiles.
    const billed = today?.totalInvoiced ?? 0;
    const spent = today?.totalExpenses ?? 0;
    const also = [
      billed > 0 ? `${formatMoney(billed)} billed` : null,
      spent > 0 ? `${formatMoney(spent)} spent` : null,
    ].filter(Boolean);
    tiles.push({
      key: 'in',
      label: 'Collected today',
      value: today === null ? null : formatMoney(today.totalCollected ?? 0),
      note: today && also.length ? also.join(' · ') : undefined,
      to: '/payments',
    });
  }
  if (outstanding !== undefined || today !== undefined) {
    tiles.push({
      key: 'owed',
      label: 'Still owed',
      value: outstanding === undefined ? null : formatMoney(outstanding),
      note: 'All open invoices',
      to: '/invoices',
    });
  }
  if (drawer !== undefined) {
    tiles.push({
      key: 'drawer',
      label: 'Cash drawer',
      value: drawer === null ? '—' : (drawerTile?.value ?? null),
      note: drawerTile?.note,
      to: '/drawer',
    });
  }

  return (
    <section className="card todaystrip" aria-label="Today at a glance">
      <ul className="todaystrip__tiles" style={{ ['--tiles' as string]: tiles.length }}>
        {tiles.map((tile) => (
          <li key={tile.key}>
            <Link to={tile.to} className="todaystrip__tile">
              <span className="daystat__label">{tile.label}</span>
              <span className="daystat__value">
                {tile.value === null ? <Skeleton width={96} height={24} /> : tile.value}
              </span>
              {tile.note && <span className="todaystrip__note">{tile.note}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DayCounts({ schedule }: { schedule: Appointment[] | null }) {
  const count = (s: ApptStatus) => schedule?.filter((a) => a.status === s).length ?? 0;
  const stats = [
    { label: 'Waiting', value: count('checked_in') },
    { label: 'In the chair', value: count('in_progress') },
    { label: 'Done', value: count('completed') },
  ];
  return (
    <section className="card" aria-label="Today in numbers">
      <div className="daystats daystats--stack">
        {stats.map((s) => (
          <div className="daystat" key={s.label}>
            <span className="daystat__value">{schedule === null ? '…' : s.value}</span>
            <span className="daystat__label">{s.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Month to date. One headline figure, a collection meter, then the rest. */
function MoneyCard({
  summary,
  canMoney,
  className = '',
}: {
  summary: FinanceSummary | null;
  canMoney: boolean;
  className?: string;
}) {
  if (!canMoney) return null;
  const collected = summary?.totalCollected ?? 0;
  const invoiced = summary?.totalInvoiced ?? 0;
  const pct =
    invoiced > 0 ? Math.min(100, Math.round((collected / invoiced) * 100)) : null;
  const profit = (summary?.totalCollected ?? 0) - (summary?.totalExpenses ?? 0);
  return (
    <section className={`card ${className}`} aria-labelledby="dash-money">
      <div className="card__head">
        <div>
          <h2 id="dash-money">This month</h2>
          <p className="card__sub">{monthLabel()}</p>
        </div>
        <Link to="/financials" className="link">
          Details <ChevronRight size={15} aria-hidden />
        </Link>
      </div>
      <div className="money">
        <div>
          <span className="money__label">Collected</span>
          {summary === null ? (
            <Skeleton width={140} height={28} />
          ) : (
            <strong className="money__value">{formatMoney(collected)}</strong>
          )}
          {pct !== null && (
            <>
              <div className="meter" aria-hidden>
                <span className="meter__fill" style={{ width: `${pct}%` }} />
              </div>
              <p className="meter__caption">
                {pct}% of {formatMoney(invoiced)} invoiced
              </p>
            </>
          )}
        </div>
        <dl className="money__rows">
          <div className="money__row">
            <dt>Expenses</dt>
            <dd>{summary === null ? '…' : formatMoney(summary.totalExpenses ?? 0)}</dd>
          </div>
          {/* A month in the red is the one number here that should stop the
              reader, so it is the one that changes colour. */}
          <div className="money__row money__row--strong">
            <dt>Profit</dt>
            <dd className={summary && profit < 0 ? 'money__negative' : undefined}>
              {summary === null ? '…' : formatMoney(profit)}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function OwedCard({
  rows,
  summary,
  className = '',
}: {
  rows: InvoiceSummaryRow[] | null;
  summary: FinanceSummary | null;
  className?: string;
}) {
  return (
    <section className={`card ${className}`} aria-labelledby="dash-owed">
      <div className="card__head">
        <div>
          <h2 id="dash-owed">Awaiting payment</h2>
          {summary && (
            <p className="card__sub">{formatMoney(summary.outstanding)} outstanding</p>
          )}
        </div>
        <Link to="/invoices" className="link" aria-label="All invoices">
          {t('nav.invoices')} <ChevronRight size={15} aria-hidden />
        </Link>
      </div>
      {rows === null ? (
        <LoadingRows rows={3} avatar label="Loading open invoices" />
      ) : rows.length === 0 ? (
        <p className="dash__calm">Every invoice is paid.</p>
      ) : (
        <ul className="list">
          {rows.map((p) => (
            <li className="row" key={p.id}>
              <Avatar name={p.patientName} size={32} />
              <span className="row__main">
                <Link to={`/invoices/${p.id}`} className="row__title row__link">
                  {p.patientName}
                </Link>
                <span className="row__sub">{p.invoiceNumber}</span>
              </span>
              <span className="row__amount">{formatMoney(p.balance)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
