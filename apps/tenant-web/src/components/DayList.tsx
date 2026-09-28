import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarPlus, ChevronRight, LogIn, Phone, ReceiptText } from 'lucide-react';
import {
  appointmentsApi,
  financeApi,
  humanError,
  type Appointment,
  type StaffMember,
} from '../lib/api';
import { dateLocale } from '../lib/strings';
import { EmptyState, StatusPill, useToast } from './ui';
import WaitingPill from './WaitingPill';

function hhmm(wall: string) {
  return new Date(wall).toLocaleTimeString(dateLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The calendar as a list: one day, in time order, one row per visit.
 *
 * The phone's calendar. A grid of practitioner columns needs a wide screen;
 * a list needs none, and it carries the desk's actions on each row — call,
 * check in, bill — so a receptionist can run the day from a phone without
 * opening anything. Tapping a row opens the visit, as in the grid.
 *
 * `appts` arrive as the calendar keeps them: wall-clock strings.
 */
export default function DayList({
  day,
  appts,
  staff,
  filterStaff,
  onFilterStaff,
  now,
  canWrite,
  canBill,
  closed,
  onOpen,
  onBook,
  onChanged,
}: {
  day: Date;
  appts: Appointment[];
  staff: StaffMember[];
  filterStaff: string;
  onFilterStaff: (id: string) => void;
  now: number;
  canWrite: boolean;
  canBill: boolean;
  closed: boolean;
  onOpen: (a: Appointment) => void;
  onBook: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [billed, setBilled] = useState<Set<string>>(new Set());

  const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;

  // Who already has an invoice dated this day, so "Bill" is offered once.
  useEffect(() => {
    if (!canBill) return;
    let live = true;
    financeApi
      .listInvoices({})
      .then((rows) => {
        if (!live) return;
        setBilled(
          new Set(
            rows
              .filter(
                (r) => r.status !== 'cancelled' && r.issuedAt.slice(0, 10) === dayKey,
              )
              .map((r) => r.patientId),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [canBill, dayKey]);

  const list = useMemo(
    () => [...appts].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    [appts],
  );
  const nextId = list.find(
    (a) =>
      (a.status === 'scheduled' || a.status === 'checked_in') &&
      Date.parse(a.endsAt) > now,
  )?.id;

  async function checkIn(a: Appointment) {
    setBusy(a.id);
    try {
      await appointmentsApi.transition(a.id, 'checked_in');
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
            onChanged();
          },
        },
      });
      onChanged();
    } catch (err) {
      toast(humanError(err, 'The check-in did not go through. Try again.'), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card daylist" aria-label="Appointments this day">
      {/* Whose day: one tap to see a single practitioner's list. */}
      {staff.length > 1 && (
        <div className="daylist__who" role="group" aria-label="Practitioner">
          <button
            type="button"
            className={`chip${!filterStaff ? ' chip--on' : ''}`}
            aria-pressed={!filterStaff}
            onClick={() => onFilterStaff('')}
          >
            Everyone
          </button>
          {staff.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`chip${filterStaff === s.id ? ' chip--on' : ''}`}
              aria-pressed={filterStaff === s.id}
              onClick={() => onFilterStaff(s.id)}
            >
              {s.fullName}
            </button>
          ))}
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState
          icon={<CalendarPlus size={22} />}
          title={closed ? 'The clinic is closed this day' : 'Nothing booked'}
          body={
            closed
              ? 'Use the arrows to move to an open day.'
              : 'Book a visit and it appears here, in time order.'
          }
          action={
            canWrite ? (
              <button type="button" className="btn btn--primary btn--sm" onClick={onBook}>
                <CalendarPlus size={15} aria-hidden /> Book appointment
              </button>
            ) : undefined
          }
        />
      ) : (
        <ol className="agenda daylist__list">
          {list.map((a) => {
            const cancelled = a.status === 'cancelled';
            const showBill =
              canBill &&
              !billed.has(a.patientId) &&
              (a.status === 'in_progress' || a.status === 'completed');
            return (
              <li
                key={a.id}
                className={`agenda__item agenda__item--${a.status}${a.id === nextId ? ' agenda__item--next' : ''}`}
              >
                <span className="agenda__time">
                  <span className="agenda__start">{hhmm(a.startsAt)}</span>
                  <span className="agenda__end">{hhmm(a.endsAt)}</span>
                </span>
                <span
                  className="agenda__rail"
                  style={a.operatoryColor ? { background: a.operatoryColor } : undefined}
                  aria-hidden
                />
                <button
                  type="button"
                  className="agenda__main daylist__open"
                  onClick={() => onOpen(a)}
                >
                  <span className="agenda__patient">{a.patientName}</span>
                  <span className="agenda__meta">
                    {a.reason}
                    {a.staffName && !filterStaff ? ` · ${a.staffName}` : ''}
                    {a.operatoryName ? ` · ${a.operatoryName}` : ''}
                  </span>
                </button>
                <span className="agenda__side">
                  {!cancelled && a.patientPhone && (
                    <a
                      href={`tel:${a.patientPhone.replace(/\s+/g, '')}`}
                      className="iconbtn agenda__call"
                      aria-label={`Call ${a.patientName}`}
                      title={a.patientPhone}
                    >
                      <Phone size={15} aria-hidden />
                    </a>
                  )}
                  {showBill ? (
                    <Link
                      to={`/invoices?new=1&patient=${encodeURIComponent(a.patientId)}&name=${encodeURIComponent(a.patientName)}`}
                      className="btn btn--ghost btn--sm agenda__checkin"
                    >
                      <ReceiptText size={14} aria-hidden /> Bill
                    </Link>
                  ) : canWrite && a.status === 'scheduled' ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm agenda__checkin"
                      disabled={busy === a.id}
                      onClick={() => void checkIn(a)}
                    >
                      <LogIn size={14} aria-hidden />
                      {busy === a.id ? 'Checking in…' : 'Check in'}
                    </button>
                  ) : a.status === 'checked_in' && a.checkedInAt ? (
                    <WaitingPill since={a.checkedInAt} />
                  ) : (
                    <StatusPill status={a.status} />
                  )}
                  <ChevronRight size={16} className="daylist__go" aria-hidden />
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
