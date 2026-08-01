import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { api, type TenantDetail, type TenantStatus } from '../lib/api';

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
            <div><span>Trial ends</span><b>{t.trial_ends_at ? fmt(t.trial_ends_at) : '—'}</b></div>
            <div><span>Created</span><b>{fmt(t.created_at)}</b></div>
          </div>
          <div className="card__head"><h2>Staff</h2></div>
          <ul className="staff">
            {t.staff.map((s) => (
              <li key={s.email}>
                <span className="staff__name">{s.full_name}</span>
                <span className="staff__email">{s.email}</span>
                <span className="staff__role">{s.role}</span>
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
    </div>
  );
}
