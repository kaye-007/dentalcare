import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, KeyRound, Copy, Check } from 'lucide-react';
import {
  api,
  ApiError,
  generatePassword,
  trialState,
  type TenantDetail,
  type TenantStatus,
} from '../lib/api';

const STATUS_LABEL: Record<TenantStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  archived: 'Archived',
};

const ACTION_LABEL: Record<string, string> = {
  'tenant.created': 'Clinic created',
  'tenant.suspended': 'Suspended',
  'tenant.reactivated': 'Reactivated',
  'tenant.archived': 'Archived',
  'tenant.trial_set': 'Trial set',
  'tenant.converted_to_paid': 'Converted to paid',
  'tenant.user_password_reset': 'Password reset',
  'role.collapsed': 'Roles migrated',
};

const ROLE_LABEL: Record<string, string> = {
  admin: 'Doctor',
  receptionist: 'Reception',
};

function fmt(s: string) {
  return new Date(s).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [t, setT] = useState<TenantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    if (!id) return;
    setLoading(true);
    try {
      setT(await api.tenant(id));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);

  async function changeStatus(status: TenantStatus) {
    if (!id) return;
    setBusy(true);
    try {
      await api.setStatus(id, status);
      await load();
    } finally {
      setBusy(false);
    }
  }

  /** `days === null` means they paid: the read-only lock lifts. */
  async function changeTrial(days: number | null) {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await api.setTrial(id, days);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the trial.');
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(userId: string) {
    if (!id) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const password = generatePassword();
      const res = await api.resetUserPassword(id, userId, password);
      // Shown once. It is bcrypted on the way in and cannot be read back.
      setIssued({ email: res.email, password });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!t) return <div className="page"><p className="muted">Not found.</p></div>;

  return (
    <div className="page">
      <Link to="/" className="back"><ChevronLeft size={16} /> All clinics</Link>

      <div className="page__head">
        <div>
          <h1>{t.name}</h1>
          <p className="muted">{t.subdomain}.dentalcare.app</p>
        </div>
        <div className="actions">
          {t.status !== 'active' && (
            <button className="btn btn--ghost" disabled={busy} onClick={() => changeStatus('active')}>Reactivate</button>
          )}
          {t.status === 'active' && (
            <button className="btn btn--ghost" disabled={busy} onClick={() => changeStatus('suspended')}>Suspend</button>
          )}
          {t.status !== 'archived' && (
            <button className="btn btn--ghost" disabled={busy} onClick={() => changeStatus('archived')}>Archive</button>
          )}
        </div>
      </div>

      <div className="cols">
        <div className="card">
          <div className="card__head"><h2>Overview</h2></div>
          <div className="kv">
            <div><span>Status</span><b><span className={`pill pill--${t.status}`}>{STATUS_LABEL[t.status]}</span></b></div>
            <div><span>Plan</span><b>{t.plan_name ?? '—'}</b></div>
            <div><span>Trial</span><b><TrialValue trialEndsAt={t.trial_ends_at} /></b></div>
            <div><span>Created</span><b>{fmt(t.created_at)}</b></div>
          </div>

          <div className="trialctl">
            <button className="tbtn" disabled={busy} onClick={() => changeTrial(7)}>
              {t.trial_ends_at ? 'Extend 7 days' : 'Start 7-day trial'}
            </button>
            <button className="tbtn" disabled={busy} onClick={() => changeTrial(30)}>
              {t.trial_ends_at ? 'Extend 30 days' : 'Start 30-day trial'}
            </button>
            {t.trial_ends_at && (
              <button className="tbtn tbtn--ok" disabled={busy} onClick={() => changeTrial(null)}>
                Mark as paid
              </button>
            )}
            {t.trial_ends_at && (
              <button className="tbtn tbtn--warn" disabled={busy} onClick={() => changeTrial(0)}>
                End trial now
              </button>
            )}
          </div>
          <p className="hint">
            Extending counts from today, not from the old date. Ending a trial
            leaves the clinic signed in and readable — it stops them adding.
          </p>
          {error && <p className="auth__error">{error}</p>}
          <div className="card__head"><h2>Staff</h2></div>
          <ul className="staff">
            {t.staff.map((s) => (
              <li key={s.id}>
                <span className="staff__name">{s.full_name}</span>
                <span className="staff__email">{s.email}</span>
                <span className="staff__role">{ROLE_LABEL[s.role] ?? s.role}</span>
                <button className="tbtn" disabled={busy}
                  title="Issue a new password"
                  onClick={() => resetPassword(s.id)}>
                  <KeyRound size={13} /> Reset
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <div className="card__head"><h2>Audit trail</h2></div>
          <ul className="timeline">
            {t.audit.map((a) => (
              <li key={a.id}>
                <span className="dot" />
                <div className="tl__body">
                  <span className="tl__action">{ACTION_LABEL[a.action] ?? a.action}</span>
                  <span className="tl__meta">
                    {a.actor_label} · {fmt(a.created_at)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {issued && (
        <div className="modal__overlay" onClick={() => setIssued(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h2>New password issued</h2>
              <p className="muted">
                Shown once — it is hashed on the way in and cannot be read back.
                The clinic sees this reset in their own activity log.
              </p>
            </div>
            <div className="modal__body">
              <pre className="handover">{`Email:    ${issued.email}\nPassword: ${issued.password}`}</pre>
              <div className="modal__foot">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={async () => {
                    await navigator.clipboard.writeText(
                      `Email: ${issued.email}\nPassword: ${issued.password}`,
                    );
                    setCopied(true);
                  }}
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button className="btn btn--primary" onClick={() => setIssued(null)}>Done</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The overview row: state first, then the date it turns on. */
function TrialValue({ trialEndsAt }: { trialEndsAt: string | null }) {
  const t = trialState(trialEndsAt);
  if (t.kind === 'paid') return <span>Paid — no restriction</span>;
  if (t.kind === 'expired') {
    return (
      <span className="trial--expired">
        Ended {fmt(t.endsAt)} · read-only
      </span>
    );
  }
  return (
    <span>
      {t.daysLeft === 1 ? '1 day left' : `${t.daysLeft} days left`} · ends {fmt(t.endsAt)}
    </span>
  );
}
