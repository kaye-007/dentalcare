import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Building2 } from 'lucide-react';
import {
  api,
  ApiError,
  type TenantRow,
  type TenantStatus,
  type Plan,
} from '../lib/api';

const STATUS_LABEL: Record<TenantStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  archived: 'Archived',
};

function StatusPill({ status }: { status: TenantStatus }) {
  return <span className={`pill pill--${status}`}>{STATUS_LABEL[status]}</span>;
}

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function TenantsPage() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [t, p] = await Promise.all([api.tenants(), api.plans()]);
      setTenants(t);
      setPlans(p);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function changeStatus(id: string, status: TenantStatus) {
    setBusyId(id);
    try {
      await api.setStatus(id, status);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const counts = useMemo(() => {
    const c = { active: 0, suspended: 0, archived: 0 };
    tenants.forEach((t) => (c[t.status] += 1));
    return c;
  }, [tenants]);

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1>Clinics</h1>
          <p className="muted">
            {tenants.length} total · {counts.active} active · {counts.suspended} suspended ·{' '}
            {counts.archived} archived
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> New clinic
        </button>
      </div>

      <div className="card">
        {loading ? (
          <div className="pad muted">Loading…</div>
        ) : tenants.length === 0 ? (
          <div className="empty">
            <Building2 size={22} />
            <p>No clinics yet. Create your first one.</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Clinic</th>
                <th>Owner</th>
                <th>Plan</th>
                <th>Users</th>
                <th>Status</th>
                <th>Created</th>
                <th className="ta-r">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="trow" onClick={() => navigate(`/tenants/${t.id}`)}>
                  <td>
                    <div className="cell-main">{t.name}</div>
                    <div className="cell-sub">{t.subdomain}.dentalcare.app</div>
                  </td>
                  <td className="muted">{t.owner_email ?? '—'}</td>
                  <td>{t.plan_name ?? '—'}</td>
                  <td>{t.user_count}</td>
                  <td><StatusPill status={t.status} /></td>
                  <td className="muted">{fmtDate(t.created_at)}</td>
                  <td className="ta-r" onClick={(e) => e.stopPropagation()}>
                    <div className="actions">
                      {t.status !== 'active' && (
                        <button className="tbtn" disabled={busyId === t.id}
                          onClick={() => changeStatus(t.id, 'active')}>Reactivate</button>
                      )}
                      {t.status === 'active' && (
                        <button className="tbtn tbtn--warn" disabled={busyId === t.id}
                          onClick={() => changeStatus(t.id, 'suspended')}>Suspend</button>
                      )}
                      {t.status !== 'archived' && (
                        <button className="tbtn" disabled={busyId === t.id}
                          onClick={() => changeStatus(t.id, 'archived')}>Archive</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && (
        <CreateModal
          plans={plans}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function CreateModal({
  plans,
  onClose,
  onCreated,
}: {
  plans: Plan[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    clinicName: '',
    subdomain: '',
    ownerFullName: '',
    ownerEmail: '',
    ownerPassword: '',
    planId: plans[0]?.id ?? '',
    trialDays: 14,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form, v: string | number) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.createTenant({
        clinicName: form.clinicName.trim(),
        subdomain: form.subdomain.trim().toLowerCase(),
        ownerFullName: form.ownerFullName.trim(),
        ownerEmail: form.ownerEmail.trim(),
        ownerPassword: form.ownerPassword,
        planId: form.planId || undefined,
        trialDays: Number(form.trialDays),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create clinic.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal__overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>New clinic</h2>
          <p className="muted">Creates the tenant and its first owner account.</p>
        </div>
        <form className="modal__body" onSubmit={submit}>
          <div className="grid2">
            <label className="field">
              <span>Clinic name</span>
              <input value={form.clinicName} onChange={(e) => set('clinicName', e.target.value)}
                placeholder="Avicena Clinic" required />
            </label>
            <label className="field">
              <span>Subdomain</span>
              <div className="suffixed">
                <input value={form.subdomain} onChange={(e) => set('subdomain', e.target.value)}
                  placeholder="northgate" required />
                <span>.dentalcare.app</span>
              </div>
            </label>
          </div>
          <label className="field">
            <span>Owner name</span>
            <input value={form.ownerFullName} onChange={(e) => set('ownerFullName', e.target.value)}
              placeholder="Dr. Adam H." required />
          </label>
          <div className="grid2">
            <label className="field">
              <span>Owner email</span>
              <input type="email" value={form.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)}
                placeholder="owner@northgate-dental.eu" required />
            </label>
            <label className="field">
              <span>Temporary password</span>
              <input value={form.ownerPassword} onChange={(e) => set('ownerPassword', e.target.value)}
                placeholder="min 8 characters" required />
            </label>
          </div>
          <div className="grid2">
            <label className="field">
              <span>Plan</span>
              <select value={form.planId} onChange={(e) => set('planId', e.target.value)}>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Trial (days)</span>
              <input type="number" min={0} max={365} value={form.trialDays}
                onChange={(e) => set('trialDays', e.target.value)} />
            </label>
          </div>
          {error && <p className="auth__error">{error}</p>}
          <div className="modal__foot">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create clinic'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
