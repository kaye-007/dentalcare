import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarPlus, MessageCircle, Phone, RotateCcw } from 'lucide-react';
import { api, humanError, type RecallPatient } from '../lib/api';
import {
  Avatar,
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeader,
  Segmented,
} from '../components/ui';
import { useAuth } from '../lib/auth';
import { plural, toDate } from '../lib/format';
import { dateLocale } from '../lib/strings';
import { inClinicZone } from '../lib/clinic-time';
import { useBooking } from '../lib/booking';
import { useMessaging } from '../lib/messaging';

type Months = '3' | '6' | '12';

function since(iso: string) {
  const months = Math.floor((Date.now() - toDate(iso).getTime()) / (30.44 * 86_400_000));
  return months >= 12
    ? `${plural(Math.floor(months / 12), 'year')} ago`
    : `${plural(months, 'month')} ago`;
}

/**
 * Who is due back for a check-up. One list, two actions per row: call them,
 * or book them. Booking is what takes a patient off the list — nothing to
 * tick, nothing to maintain.
 */
export default function RecallPage() {
  const { can, readOnly } = useAuth();
  const canBook = can('appointments:write') && !readOnly;
  const canMessage = can('reminders:send') && !readOnly;
  const openMessage = useMessaging();
  const openBooking = useBooking();
  const [months, setMonths] = useState<Months>('6');
  const [rows, setRows] = useState<RecallPatient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    api
      .recallDue(Number(months))
      .then((r) => live && setRows(r.items))
      .catch(
        (err) =>
          live && setError(humanError(err, 'The recall list could not be loaded.')),
      );
    return () => {
      live = false;
    };
  }, [months, attempt]);

  return (
    <div className="page">
      <PageHeader
        title="Recall"
        meta={
          rows === null
            ? 'Patients due for a check-up'
            : rows.length === 0
              ? 'Nobody is due right now'
              : `${plural(rows.length, 'patient')} due for a check-up · nothing booked yet`
        }
        actions={
          <Segmented<Months>
            label="Last visit more than"
            value={months}
            onChange={setMonths}
            options={[
              { value: '3', label: '3 months' },
              { value: '6', label: '6 months' },
              { value: '12', label: '1 year' },
            ]}
          />
        }
      />

      <section className="card">
        {error ? (
          <ErrorState body={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : rows === null ? (
          <LoadingRows rows={6} avatar label="Loading the recall list" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<RotateCcw size={22} />}
            title="Everyone is up to date"
            body={`No active patient's last visit is more than ${
              months === '12' ? 'a year' : `${months} months`
            } ago without a booking since.`}
          />
        ) : (
          <ul className="recall">
            {rows.map((r) => {
              const name = `${r.firstName} ${r.lastName}`;
              return (
                <li key={r.id} className="recall__row">
                  <Avatar name={name} />
                  <div className="recall__who">
                    <Link to={`/patients/${r.id}`} className="recall__name">
                      {name}
                    </Link>
                    <span className="recall__meta">
                      Last visit{' '}
                      {toDate(r.lastVisit).toLocaleDateString(
                        dateLocale(),
                        inClinicZone({ day: 'numeric', month: 'short', year: 'numeric' }),
                      )}{' '}
                      · {since(r.lastVisit)}
                      {r.lastReason ? ` · ${r.lastReason}` : ''}
                    </span>
                  </div>
                  <div className="recall__do">
                    {r.phone && (
                      <a
                        href={`tel:${r.phone.replace(/\s+/g, '')}`}
                        className="iconbtn"
                        aria-label={`Call ${name}`}
                        title={r.phone}
                      >
                        <Phone size={15} aria-hidden />
                      </a>
                    )}
                    {canMessage && r.phone && (
                      // Most patients answer WhatsApp before the phone: the
                      // invitation is written, shown, and sent from the desk.
                      <button
                        type="button"
                        className="iconbtn"
                        aria-label={`Message ${name}`}
                        title="Invite back on WhatsApp"
                        onClick={() =>
                          openMessage({
                            patientId: r.id,
                            patientName: name,
                            purpose: 'recall_invitation',
                          })
                        }
                      >
                        <MessageCircle size={15} aria-hidden />
                      </button>
                    )}
                    {canBook && (
                      // Booked here, the patient leaves the list at once.
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        aria-label={`Book ${name}`}
                        onClick={() =>
                          openBooking({
                            patientId: r.id,
                            onSaved: () => setAttempt((n) => n + 1),
                          })
                        }
                      >
                        <CalendarPlus size={14} aria-hidden /> Book
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
