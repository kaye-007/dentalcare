import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import {
  WHATSAPP_SEND_STATUSES,
  WHATSAPP_SEND_STATUS_LABELS,
  type WhatsAppSendStatus,
} from '@dentalcare/shared';
import {
  whatsappApi,
  type WhatsAppBatch,
  type WhatsAppSend,
  humanError,
} from '../../lib/api';
import { EmptyState, StatusPill, LoadingRows } from '../ui';
import { SEND_PILL } from './RemindersTab';

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Every reminder the clinic sent, one click at a time, and what WhatsApp said about each. */
export default function HistoryTab() {
  const [batches, setBatches] = useState<WhatsAppBatch[] | null>(null);
  const [sends, setSends] = useState<WhatsAppSend[] | null>(null);
  const [batchId, setBatchId] = useState<string>('');
  const [status, setStatus] = useState<WhatsAppSendStatus | ''>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    whatsappApi
      .history({ batchId: batchId || undefined, status })
      .then((h) => {
        setBatches(h.batches);
        setSends(h.sends);
      })
      .catch((e) => setError(humanError(e)));
  }, [batchId, status]);

  if (error) return <p className="formerror">{error}</p>;
  if (!batches || !sends) return <LoadingRows rows={3} label="Loading" />;
  if (batches.length === 0) {
    return (
      <EmptyState
        framed
        icon={<History size={22} />}
        title="No reminders sent yet"
        body="Every reminder sent from Appointment reminders is recorded here, with what WhatsApp said about it."
      />
    );
  }

  return (
    <div className="wa-stack">
      <section className="card">
        <div className="card__head">
          <h2>Sends</h2>
        </div>
        <ul className="wa-batches">
          {batches.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                className={`wa-batch${batchId === b.id ? ' is-picked' : ''}`}
                onClick={() => setBatchId(batchId === b.id ? '' : b.id)}
                aria-pressed={batchId === b.id}
              >
                <span className="wa-batch__when">
                  {when(b.startedAt)} · for{' '}
                  {new Date(`${b.date}T12:00:00Z`).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    timeZone: 'UTC',
                  })}
                </span>
                <span className="small muted">
                  {b.templateName}
                  {b.by ? ` · ${b.by}` : ''}
                </span>
                <span className="wa-batch__counts">
                  <span className="wa-count wa-count--ok">Sent: {b.sent}</span>
                  <span className={`wa-count${b.failed ? ' wa-count--bad' : ''}`}>
                    Failed: {b.failed}
                  </span>
                  <span className="wa-count">Skipped: {b.skipped}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="card__head">
          <div>
            <h2>Messages</h2>
            <p className="card__sub">
              {batchId ? 'From the selected send' : 'The most recent 500'}
            </p>
          </div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as WhatsAppSendStatus | '')}
            aria-label="Status"
          >
            <option value="">Every status</option>
            {WHATSAPP_SEND_STATUSES.map((s) => (
              <option key={s} value={s}>
                {WHATSAPP_SEND_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Patient</th>
                <th className="hide-sm hide-md">Phone number</th>
                <th className="hide-sm hide-md">Appointment</th>
                <th className="hide-sm hide-md">Template</th>
                <th className="hide-sm hide-md">Sent by</th>
                <th className="hide-sm hide-md">Sent</th>
                <th>Status</th>
                <th className="hide-sm">Failure reason</th>
              </tr>
            </thead>
            <tbody>
              {sends.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/patients/${s.patientId}`} className="table__link">
                      {s.patientName}
                    </Link>
                    {/* Phones and tablets: which visit, under the name. The
                        send itself (when, template, who) is in Sends above. */}
                    <span className="cell-sub only-sm show-md">
                      Appointment {when(s.appointmentAt)}
                    </span>
                  </td>
                  <td className="wa-mono hide-sm hide-md">{s.phone ?? '—'}</td>
                  <td className="hide-sm hide-md">{when(s.appointmentAt)}</td>
                  <td className="hide-sm hide-md">{s.templateName}</td>
                  <td className="hide-sm hide-md">{s.sentBy ?? '—'}</td>
                  <td className="hide-sm hide-md">{when(s.sentAt ?? s.createdAt)}</td>
                  <td>
                    <StatusPill
                      status={SEND_PILL[s.status]}
                      label={WHATSAPP_SEND_STATUS_LABELS[s.status]}
                    />
                    {/* On a phone the reason rides under the status. */}
                    {s.failureReason && (
                      <span className="cell-sub only-sm">{s.failureReason}</span>
                    )}
                  </td>
                  <td className="small muted hide-sm">{s.failureReason ?? ''}</td>
                </tr>
              ))}
              {sends.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="muted"
                    style={{ textAlign: 'center', padding: 24 }}
                  >
                    Nothing with this status.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
