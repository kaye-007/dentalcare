import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  Search,
  Send,
  TriangleAlert,
} from 'lucide-react';
import {
  WHATSAPP_SEND_STATUS_LABELS,
  renderWhatsAppPreview,
  type WhatsAppSendStatus,
} from '@dentalcare/shared';
import {
  ApiError,
  newIdempotencyKey,
  whatsappApi,
  type ReminderDay,
  type ReminderRow,
  type WhatsAppBatch,
  type WhatsAppSend,
  humanError,
} from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Modal, StatusPill, LoadingRows } from '../ui';

type Filter = 'all' | 'eligible' | 'excluded' | 'reminded' | 'failed';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'eligible', label: 'Can be reminded' },
  { key: 'excluded', label: 'Excluded' },
  { key: 'reminded', label: 'Reminded' },
  { key: 'failed', label: 'Failed' },
];

// A reminder that went out is the expected result: a quiet ✓, like a paid
// invoice. Colour stays for what needs a look (failed, still in flight).
export const SEND_PILL: Record<WhatsAppSendStatus, string> = {
  queued: 'info',
  sending: 'warn',
  accepted: 'done',
  sent: 'done',
  failed: 'danger',
  skipped: 'neutral',
  already_sent: 'neutral',
};

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

/**
 * Tomorrow's appointments, and a reminder for each patient who can have one.
 * The receptionist chooses; the API decides again before anything is sent.
 */
export default function RemindersTab() {
  const { can } = useAuth();
  const [date, setDate] = useState<string | undefined>(undefined);
  const [day, setDay] = useState<ReminderDay | null>(null);
  const [tomorrow, setTomorrow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [dialog, setDialog] = useState<null | 'preview' | 'confirm'>(null);
  const [result, setResult] = useState<
    (WhatsAppBatch & { sends: WhatsAppSend[] }) | null
  >(null);

  const load = useCallback(() => {
    setError(null);
    whatsappApi
      .day(date)
      .then((d) => {
        setDay(d);
        if (!date) setTomorrow(d.date);
        // Keep only choices that can still be sent.
        setSelected(
          (cur) =>
            new Set(
              d.rows
                .filter((r) => !r.exclusion && cur.has(r.appointmentId))
                .map((r) => r.appointmentId),
            ),
        );
      })
      .catch((e) => setError(humanError(e)));
  }, [date]);

  useEffect(load, [load]);

  const rows = useMemo(() => {
    if (!day) return [];
    const q = query.trim().toLowerCase();
    // "069 123…" as typed at the desk matches "+35569123…" as stored.
    const digits = q.replace(/\D/g, '').replace(/^0+/, '');
    return day.rows.filter((r) => {
      if (
        q &&
        !r.patientName.toLowerCase().includes(q) &&
        !(digits && (r.whatsappPhone ?? '').includes(digits))
      ) {
        return false;
      }
      switch (filter) {
        case 'eligible':
          return r.exclusion === null;
        case 'excluded':
          return r.exclusion !== null;
        case 'reminded':
          return (
            r.reminder !== null &&
            ['accepted', 'sent', 'sending', 'queued'].includes(r.reminder.status)
          );
        case 'failed':
          return r.reminder?.status === 'failed';
        default:
          return true;
      }
    });
  }, [day, query, filter]);

  if (error) return <p className="formerror">{error}</p>;
  if (!day) return <LoadingRows rows={3} label="Loading tomorrow’s appointments" />;

  const eligible = day.rows.filter((r) => r.exclusion === null);
  const chosen = day.rows.filter((r) => selected.has(r.appointmentId));
  const setupProblem = !day.connection.connected
    ? 'WhatsApp is not connected yet.'
    : !day.template
      ? 'There is no default reminder template yet.'
      : !day.template.ready
        ? `The reminder template “${day.template.displayName}” is not ready: ${day.template.meta.problem ?? 'Meta has not approved it.'}`
        : null;
  const isTomorrow = day.date === tomorrow;

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="wa-stack">
      {setupProblem && (
        <div className="alertbanner" role="status">
          <TriangleAlert size={16} aria-hidden />
          <span>
            {setupProblem}{' '}
            {can('settings:manage') ? (
              <Link
                to={
                  !day.connection.connected ? '/messages/settings' : '/messages/templates'
                }
                className="table__link"
              >
                {!day.connection.connected ? 'Connect WhatsApp' : 'Open templates'}
              </Link>
            ) : (
              'Ask an administrator to set it up.'
            )}
          </span>
        </div>
      )}

      <section className="card">
        <div className="card__head wa-dayhead">
          <div>
            <h2 className="inline-row" style={{ gap: 8 }}>
              <CalendarDays size={18} aria-hidden />
              {isTomorrow ? 'Tomorrow' : 'Appointments'}, {longDate(day.date)}
            </h2>
            <p className="card__sub">
              {day.connection.connected
                ? `From ${day.clinic.name}${day.connection.displayPhoneNumber ? ` (${day.connection.displayPhoneNumber})` : ''}`
                : 'WhatsApp not connected'}
              {day.template ? ` · Template: ${day.template.displayName}` : ''}
            </p>
          </div>
          <div className="inline-row" style={{ gap: 6 }}>
            <button
              type="button"
              className="iconbtn"
              aria-label="Previous day"
              onClick={() => setDate(shiftDate(day.date, -1))}
            >
              <ChevronLeft size={16} />
            </button>
            {!isTomorrow && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setDate(undefined)}
              >
                Tomorrow
              </button>
            )}
            <button
              type="button"
              className="iconbtn"
              aria-label="Next day"
              onClick={() => setDate(shiftDate(day.date, 1))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        <dl className="wa-summary">
          {[
            ['Appointments', day.summary.total],
            ['Can be reminded', day.summary.eligible],
            ['Already reminded', day.summary.alreadyReminded],
            ['No WhatsApp consent', day.summary.noConsent],
            ['Missing or invalid phone', day.summary.phoneProblem],
            ['Cancelled', day.summary.cancelled],
          ].map(([label, n]) => (
            <div key={label} className="wa-summary__item">
              <dt>{label}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>

        {day.rows.length === 0 ? (
          <div className="pad">
            <EmptyState
              icon={<CalendarDays size={22} />}
              title="No appointments on this day"
            />
          </div>
        ) : (
          <>
            <div className="wa-toolbar">
              <label className="searchbox">
                <Search size={15} aria-hidden />
                <span className="sr-only">Search by patient name or phone number</span>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Name or phone number…"
                />
              </label>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as Filter)}
                aria-label="Show"
              >
                {FILTERS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
              <div className="wa-toolbar__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={eligible.length === 0}
                  onClick={() =>
                    setSelected(
                      selected.size === eligible.length && eligible.length > 0
                        ? new Set()
                        : new Set(eligible.map((r) => r.appointmentId)),
                    )
                  }
                >
                  {selected.size === eligible.length && eligible.length > 0
                    ? 'Clear selection'
                    : `Select all eligible (${eligible.length})`}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={chosen.length === 0 || !day.template}
                  onClick={() => setDialog('preview')}
                >
                  <Eye size={15} aria-hidden /> Preview
                </button>
                {can('reminders:send') && (
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={chosen.length === 0 || setupProblem !== null}
                    onClick={() => setDialog('confirm')}
                  >
                    <Send size={15} aria-hidden /> Send {chosen.length || ''} reminder
                    {chosen.length === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            </div>

            <div className="table-scroll">
              <table className="table wa-table">
                <thead>
                  <tr>
                    <th className="wa-table__check">
                      <span className="sr-only">Select</span>
                    </th>
                    <th>Patient</th>
                    <th className="hide-sm hide-md">WhatsApp number</th>
                    <th className="hide-sm hide-md">Time</th>
                    <th className="hide-sm">Appointment</th>
                    <th>Reminder</th>
                    <th className="hide-sm hide-md">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Row
                      key={r.appointmentId}
                      row={r}
                      checked={selected.has(r.appointmentId)}
                      onToggle={toggle}
                    />
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="muted"
                        style={{ textAlign: 'center', padding: 24 }}
                      >
                        Nothing matches.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {result && <ResultCard batch={result} onClose={() => setResult(null)} />}

      {dialog === 'preview' && day.template && (
        <Modal
          title="Message preview"
          subtitle={`${chosen.length} patient${chosen.length === 1 ? '' : 's'} · ${day.template.displayName}`}
          onClose={() => setDialog(null)}
          wide
        >
          <div className="modal__body">
            <ul className="wa-previews">
              {chosen.map((r) => (
                <li key={r.appointmentId}>
                  <p className="wa-previews__who">
                    <strong>{r.patientName}</strong>{' '}
                    <span className="muted small">{r.whatsappPhone}</span>
                  </p>
                  <p className="wa-bubble">
                    {renderWhatsAppPreview(day.template!.previewBody, r.values)}
                  </p>
                </li>
              ))}
            </ul>
            <p className="muted small">
              WhatsApp shows the wording of the approved Meta template, filled with these
              same details.
            </p>
            <div className="modal__foot">
              <div className="modal__foot-right">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setDialog(null)}
                >
                  Close
                </button>
                {can('reminders:send') && setupProblem === null && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => setDialog('confirm')}
                  >
                    Continue to send
                  </button>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {dialog === 'confirm' && day.template && (
        <ConfirmSend
          day={day}
          chosen={chosen}
          isTomorrow={isTomorrow}
          onClose={() => setDialog(null)}
          onSent={(batch) => {
            setDialog(null);
            setResult(batch);
            setSelected(new Set());
            load();
          }}
        />
      )}
    </div>
  );
}

function Row({
  row: r,
  checked,
  onToggle,
}: {
  row: ReminderRow;
  checked: boolean;
  onToggle: (id: string) => void;
}) {
  const excluded = r.exclusion !== null;
  const time = new Date(r.startsAt);
  return (
    <tr
      className={excluded ? 'wa-row--excluded' : 'row--click'}
      onClick={excluded ? undefined : () => onToggle(r.appointmentId)}
    >
      <td className="wa-table__check">
        <input
          type="checkbox"
          checked={checked}
          disabled={excluded}
          onChange={() => onToggle(r.appointmentId)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${r.patientName}`}
        />
      </td>
      <td>
        <Link
          to={`/patients/${r.patientId}`}
          className="table__link"
          onClick={(e) => e.stopPropagation()}
        >
          {r.patientName}
        </Link>
        {/* On a phone: the time, and why a row cannot be sent, under the name. */}
        <span className="cell-sub only-sm show-md">
          {[
            r.values.appointment_time || time.toISOString().slice(11, 16),
            r.exclusionLabel,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </td>
      <td className="wa-mono hide-sm hide-md">{r.whatsappPhone ?? '—'}</td>
      <td className="wa-mono hide-sm hide-md">
        {r.values.appointment_time || time.toISOString().slice(11, 16)}
      </td>
      <td className="hide-sm">
        {/* "Scheduled" is what tomorrow's bookings are; only the exceptions
            (cancelled, no-show) get a pill. */}
        {r.appointmentStatus === 'scheduled' ? (
          <span className="muted small">Scheduled</span>
        ) : (
          <StatusPill status={r.appointmentStatus} />
        )}
      </td>
      <td>
        {r.reminder ? (
          <span title={r.reminder.failureReason ?? undefined}>
            <StatusPill
              status={SEND_PILL[r.reminder.status]}
              label={WHATSAPP_SEND_STATUS_LABELS[r.reminder.status]}
            />
          </span>
        ) : (
          <span className="muted small">Not sent</span>
        )}
      </td>
      <td className="small hide-sm hide-md">
        {r.exclusionLabel ??
          (r.reminder?.status === 'failed' ? (
            <span className="muted">{r.reminder.failureReason}</span>
          ) : (
            ''
          ))}
      </td>
    </tr>
  );
}

function ConfirmSend({
  day,
  chosen,
  isTomorrow,
  onClose,
  onSent,
}: {
  day: ReminderDay;
  chosen: ReminderRow[];
  isTomorrow: boolean;
  onClose: () => void;
  onSent: (batch: WhatsAppBatch & { sends: WhatsAppSend[] }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key for this confirmation: a double click or a retry sends once.
  const [key] = useState(newIdempotencyKey);
  const n = chosen.length;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      onSent(
        await whatsappApi.send(
          {
            date: day.date,
            templateId: day.template!.id,
            appointmentIds: chosen.map((r) => r.appointmentId),
          },
          key,
        ),
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The reminders could not be sent.',
      );
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Send WhatsApp appointment reminders?"
      subtitle={`You are about to send ${n} reminder${n === 1 ? '' : 's'}.`}
      onClose={busy ? () => undefined : onClose}
    >
      <div className="modal__body">
        <dl className="wa-confirm">
          <div>
            <dt>From</dt>
            <dd>
              {day.clinic.name}
              {day.connection.displayPhoneNumber
                ? ` (${day.connection.displayPhoneNumber})`
                : ''}
            </dd>
          </div>
          <div>
            <dt>Template</dt>
            <dd>{day.template!.displayName}</dd>
          </div>
          <div>
            <dt>Appointment date</dt>
            <dd>{isTomorrow ? `Tomorrow, ${longDate(day.date)}` : longDate(day.date)}</dd>
          </div>
          <div>
            <dt>Recipients</dt>
            <dd>
              {n} patient{n === 1 ? '' : 's'}
            </dd>
          </div>
        </dl>
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void send()}
              disabled={busy}
            >
              {busy ? 'Sending…' : `Send ${n} reminder${n === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ResultCard({
  batch,
  onClose,
}: {
  batch: WhatsAppBatch & { sends: WhatsAppSend[] };
  onClose: () => void;
}) {
  const problems = batch.sends.filter((s) => !s.live || s.status === 'sending');
  return (
    <section className="card wa-result" role="status">
      <div className="card__head">
        <div>
          <h2 className="inline-row" style={{ gap: 8 }}>
            <CheckCircle2 size={18} color="var(--ok-fg)" aria-hidden /> Reminders sent
          </h2>
          <p className="card__sub">
            Sent: {batch.sent} · Failed: {batch.failed} · Skipped: {batch.skipped}
          </p>
        </div>
        <div className="inline-row" style={{ gap: 6 }}>
          <Link to="/messages/history" className="btn btn--ghost btn--sm">
            Send history
          </Link>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Dismiss
          </button>
        </div>
      </div>
      {problems.length > 0 && (
        <ul className="drawer-list pad">
          {problems.map((s) => (
            <li key={s.id}>
              <strong>{s.patientName}</strong> —{' '}
              <StatusPill
                status={SEND_PILL[s.status]}
                label={WHATSAPP_SEND_STATUS_LABELS[s.status]}
              />{' '}
              <span className="muted small">{s.failureReason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
