import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, RefreshCw, Send } from 'lucide-react';
import {
  ApiError,
  fiscalApi,
  type FiscalQueue,
  type FiscalQueueItem,
  humanError,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoney } from '../lib/format';
import { EmptyState, PageHeader, StatusPill, LoadingRows } from '../components/ui';

/**
 * What the tax authority has not taken yet.
 *
 * An invoice is legally issued the moment it is signed: the patient has a
 * receipt with its NSLF and QR, and the law allows the registration itself to
 * follow within 48 hours. The scheduler retries on its own; this page exists
 * so the clinic can see how that is going, push one by hand, and — the part
 * that matters — notice the ones running out of time.
 */
export default function FiscalQueuePage() {
  const { can } = useAuth();
  const [queue, setQueue] = useState<FiscalQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    fiscalApi
      .queue()
      .then((q) => {
        setQueue(q);
        setError(null);
      })
      .catch((e) => setError(humanError(e)));
  }, []);

  useEffect(load, [load]);

  async function retry(item: FiscalQueueItem) {
    setBusyId(item.id);
    setError(null);
    try {
      await fiscalApi.retry(item.id);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send it again.');
    } finally {
      setBusyId(null);
    }
  }

  const counts = queue?.counts;

  return (
    <div className="page">
      <PageHeader
        title="Fiscal queue"
        meta="Invoices issued and not yet registered with the tax authority"
        actions={
          <button className="btn btn--ghost btn--sm" onClick={load}>
            <RefreshCw size={15} aria-hidden /> Refresh
          </button>
        }
      />

      {counts && (
        <div className="stats">
          <div className="stat">
            <span className="stat__label">Waiting</span>
            <span className="stat__value">{counts.pending}</span>
            <span className="stat__sub">retried automatically</span>
          </div>
          <div className={`stat${counts.urgent ? ' stat--alert' : ''}`}>
            <span className="stat__label">Running out of time</span>
            <span className="stat__value">{counts.urgent}</span>
            <span className="stat__sub">over 40 hours old</span>
          </div>
          <div className={`stat${counts.overdue ? ' stat--alert' : ''}`}>
            <span className="stat__label">Past 48 hours</span>
            <span className="stat__value">{counts.overdue}</span>
            <span className="stat__sub">delivered late</span>
          </div>
          <div className={`stat${counts.rejected ? ' stat--alert' : ''}`}>
            <span className="stat__label">Refused</span>
            <span className="stat__value">{counts.rejected}</span>
            <span className="stat__sub">need a person</span>
          </div>
        </div>
      )}

      {error && <p className="formerror">{error}</p>}

      <section className="card">
        {queue === null ? (
          <LoadingRows rows={3} label="Loading" />
        ) : queue.items.length === 0 ? (
          <div className="pad">
            <EmptyState
              icon={<CheckCircle2 size={22} />}
              title="Everything is registered"
              body="Every invoice this clinic issued has its NIVF from the tax authority."
            />
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Patient</th>
                  <th className="num">Total</th>
                  <th>Issued</th>
                  <th>Time left</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue.items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link to={`/invoices/${i.invoiceId}`} className="table__link">
                        {i.invoiceNumber}
                      </Link>
                      {i.environment === 'test' && (
                        <div className="small muted">test environment</div>
                      )}
                    </td>
                    <td>{i.patientName}</td>
                    <td className="num">{formatMoney(i.total)}</td>
                    <td>
                      {new Date(i.issueDateTime).toLocaleString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className={`queue-urgency queue-urgency--${i.urgency}`}>
                      {timeLeft(i)}
                    </td>
                    <td>
                      {i.status === 'rejected' ? (
                        <>
                          <StatusPill status="danger" label="Refused" />
                          {i.lastError && (
                            <div className="small muted">{i.lastError}</div>
                          )}
                        </>
                      ) : (
                        <>
                          <StatusPill
                            status={i.overdue ? 'danger' : 'warn'}
                            label="Waiting"
                          />
                          <div className="small muted">
                            {i.attempts} attempt{i.attempts === 1 ? '' : 's'}
                            {i.lastError ? ` · ${i.lastError}` : ''}
                          </div>
                        </>
                      )}
                    </td>
                    <td>
                      {i.status === 'pending' && can('invoices:fiscalize') && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busyId === i.id}
                          onClick={() => void retry(i)}
                        >
                          <Send size={14} aria-hidden />{' '}
                          {busyId === i.id ? 'Sending…' : 'Send now'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="muted small">
        An invoice is valid for the patient from the moment it is signed: it carries its
        NSLF and QR code. The law allows the registration to follow within 48 hours, which
        is what this queue counts down.
      </p>
    </div>
  );
}

function timeLeft(i: FiscalQueueItem): string {
  if (i.status === 'rejected') return '—';
  if (i.overdue) return `${hours(-i.msLeft)} over`;
  return `${hours(i.msLeft)} left`;
}

function hours(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}
