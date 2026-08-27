import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Building2, Rocket, Copy, Check } from 'lucide-react';
import {
  api,
  ApiError,
  generatePassword,
  trialState,
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

/** The countdown, in the words the person reading it would use. */
function TrialCell({ trialEndsAt }: { trialEndsAt: string | null }) {
  const t = trialState(trialEndsAt);
  if (t.kind === 'paid') return <span className="muted">Paid</span>;
  if (t.kind === 'expired') {
    return (
      <span className="pill pill--suspended">
        {t.daysAgo === 0 ? 'Expired today' : `Expired ${t.daysAgo}d ago`}
      </span>
    );
  }
  return (
    <span className={`pill ${t.daysLeft <= 2 ? 'pill--warn' : 'pill--trial'}`}>
      {t.daysLeft === 1 ? '1 day left' : `${t.daysLeft} days left`}
    </span>
  );
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
  const [showCreate, setShowCreate] = useState<'clinic' | 'demo' | null>(null);
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
        <div className="actions">
          <button className="btn btn--ghost" onClick={() => setShowCreate('demo')}>
            <Rocket size={16} /> New demo (7 days)
          </button>
          <button className="btn btn--primary" onClick={() => setShowCreate('clinic')}>
            <Plus size={16} /> New clinic
          </button>
        </div>
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
                <th>Trial</th>
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
                  <td><TrialCell trialEndsAt={t.trial_ends_at} /></td>
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
          demo={showCreate === 'demo'}
          onClose={() => setShowCreate(null)}
          onCreated={async () => {
            await load();
          }}
        />
      )}
    </div>
  );
}

function CreateModal({
  plans,
  demo,
  onClose,
  onCreated,
}: {
  plans: Plan[];
  demo: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    clinicName: '',
    subdomain: '',
    ownerFullName: '',
    ownerEmail: '',
    // A demo gets a generated password: it has to be handed over on a call,
    // and a human choosing one on the spot picks the same weak one every time.
    ownerPassword: demo ? generatePassword() : '',
    planId: plans[0]?.id ?? '',
    trialDays: demo ? 7 : 14,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set once the clinic exists, so the credentials can be read out. */
  const [created, setCreated] = useState<{ subdomain: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const set = (k: keyof typeof form, v: string | number) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.createTenant({
        clinicName: form.clinicName.trim(),
        subdomain: form.subdomain.trim().toLowerCase(),
        ownerFullName: form.ownerFullName.trim(),
        ownerEmail: form.ownerEmail.trim(),
        ownerPassword: form.ownerPassword,
        planId: form.planId || undefined,
        trialDays: Number(form.trialDays),
      });
      // The password is not stored anywhere readable and cannot be shown
      // again, so the modal stays open on the hand-over screen rather than
      // closing over the one moment it exists in plain text.
      setCreated({ subdomain: res.subdomain });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create clinic.');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const handover = [
      `${created.subdomain}.dentalcare.app`,
      `Email:    ${form.ownerEmail.trim()}`,
      `Password: ${form.ownerPassword}`,
    ].join('\n');
    return (
      <div className="modal__overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal__head">
            <h2>{form.clinicName} is live</h2>
            <p className="muted">
              {demo ? 'Seven days from now it locks to read-only. ' : ''}
              This password is not stored in readable form — copy it now.
            </p>
          </div>
          <div className="modal__body">
            <pre className="handover">{handover}</pre>
            <div className="modal__foot">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={async () => {
                  await navigator.clipboard.writeText(handover);
                  setCopied(true);
                }}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? 'Copied' : 'Copy details'}
              </button>
              <button className="btn btn--primary" onClick={onClose}>Done</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal__overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>{demo ? 'New demo clinic' : 'New clinic'}</h2>
          <p className="muted">
            {demo
              ? 'A real clinic with a 7-day trial. It locks to read-only when the trial ends — their data stays visible.'
              : 'Creates the tenant and its first doctor account.'}
          </p>
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
            <span>Doctor's name</span>
            <input value={form.ownerFullName} onChange={(e) => set('ownerFullName', e.target.value)}
              placeholder="Dr. Adam H." required />
          </label>
          <div className="grid2">
            <label className="field">
              <span>Doctor's email</span>
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
