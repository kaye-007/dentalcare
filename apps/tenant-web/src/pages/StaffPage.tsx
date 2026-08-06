import { useEffect, useState, type FormEvent } from 'react';
import { Plus, UserCog, Pencil, Lock, Wallet } from 'lucide-react';
import {
  staffApi,
  settingsApi,
  ApiError,
  type StaffFull,
  type SalaryPayment,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, PageHeader, StatusPill, EmptyState, Modal } from '../components/ui';
import { formatMoney, plural } from '../lib/format';

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function StaffPage() {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const [tab, setTab] = useState<'team' | 'salary'>('team');
  const [items, setItems] = useState<StaffFull[] | null>(null);
  const [payrollEnabled, setPayrollEnabled] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StaffFull | null>(null);
  const [paying, setPaying] = useState<StaffFull | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [logVersion, setLogVersion] = useState(0);

  async function load() {
    setItems(await staffApi.list());
  }
  useEffect(() => {
    void load();
    if (isOwner) {
      settingsApi.get().then((s) => setPayrollEnabled(s.payrollLoggingEnabled)).catch(() => undefined);
    }
  }, [isOwner]);

  if (!isOwner) {
    return (
      <div className="page">
        <EmptyState
          framed
          icon={<Lock size={22} />}
          title="Owner access only"
          body="Staff management and payroll are restricted to the clinic owner."
        />
      </div>
    );
  }

  async function toggleStatus(s: StaffFull) {
    setBusyId(s.id);
    try {
      await staffApi.update(s.id, { status: s.status === 'active' ? 'disabled' : 'active' });
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Could not update staff member.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Staff"
        meta={items ? `${plural(items.length, 'team member')} · ${items.filter((s) => s.status === 'active').length} active · access roles: Owner / Frontdesk` : '…'}
        actions={
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Add staff
          </button>
        }
      />

      <div className="toolbar">
        <div className="tabs">
          <button className={`tab${tab === 'team' ? ' tab--active' : ''}`} onClick={() => setTab('team')}>Team</button>
          {payrollEnabled && (
            <button className={`tab${tab === 'salary' ? ' tab--active' : ''}`} onClick={() => setTab('salary')}>
              Salary log
            </button>
          )}
        </div>
      </div>

      {tab === 'salary' && payrollEnabled ? (
        <SalaryLog key={logVersion} />
      ) : (
        <div className="card">
          {items === null ? (
            <div className="pad muted">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState icon={<UserCog size={22} />} title="No staff yet" body="Add your first team member." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Position</th>
                  <th>Access</th>
                  <th>Salary</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((s) => {
                  const isSelf = s.id === user?.id;
                  return (
                    <tr key={s.id}>
                      <td>
                        <div className="namecell">
                          <Avatar name={s.fullName} size={32} />
                          <span>
                            <span>{s.fullName}{isSelf && <span className="muted" style={{ fontWeight: 400 }}> (you)</span>}</span>
                            <span className="cell-sub" style={{ display: 'block', fontWeight: 400 }}>{s.email}</span>
                          </span>
                        </div>
                      </td>
                      <td className="muted">{s.position ?? '—'}</td>
                      <td>
                        <StatusPill
                          status={s.role === 'owner' ? 'info' : 'neutral'}
                          label={s.role === 'owner' ? 'Owner' : 'Frontdesk'}
                        />
                      </td>
                      <td>
                        {s.salaryAmount ? (
                          <span style={{ fontWeight: 600 }}>
                            {formatMoney(s.salaryAmount)}
                            <span className="muted" style={{ fontWeight: 400 }}> /mo</span>
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <StatusPill status={s.status === 'active' ? 'active' : 'inactive'}
                          label={s.status === 'active' ? 'Active' : 'Disabled'} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          {payrollEnabled && s.status === 'active' && (
                            <button className="btn btn--ghost btn--sm" onClick={() => setPaying(s)}
                              title="Record salary payment">
                              <Wallet size={14} /> Record payment
                            </button>
                          )}
                          <button className="iconbtn" style={{ width: 30, height: 30 }}
                            onClick={() => setEditing(s)} title="Edit">
                            <Pencil size={14} />
                          </button>
                          {!isSelf && (
                            <button
                              className={`btn btn--sm ${s.status === 'active' ? 'btn--danger-ghost' : 'btn--ghost'}`}
                              disabled={busyId === s.id}
                              onClick={() => toggleStatus(s)}
                            >
                              {s.status === 'active' ? 'Disable' : 'Enable'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {(creating || editing) && (
        <StaffModal
          member={editing ?? undefined}
          selfId={user?.id ?? ''}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={async () => { setCreating(false); setEditing(null); await load(); }}
        />
      )}
      {paying && (
        <SalaryPaymentModal
          member={paying}
          onClose={() => setPaying(null)}
          onSaved={() => { setPaying(null); setLogVersion((v) => v + 1); setTab('salary'); }}
        />
      )}
    </div>
  );
}

/* ── salary log (owner) ─────────────────────────────────── */
function SalaryLog() {
  const [items, setItems] = useState<SalaryPayment[] | null>(null);
  useEffect(() => {
    staffApi.salaryPayments().then(setItems).catch(() => setItems([]));
  }, []);
  const total = (items ?? []).reduce((s, p) => s + p.amount, 0);
  return (
    <div className="card">
      <div className="card__head">
        <div>
          <h2>Salary payment log</h2>
          <p className="card__sub">
            {items === null ? '…' : `${plural(items.length, 'payment')} · ${formatMoney(total)} recorded`}
            {' '}· lightweight log for payments made outside the system
          </p>
        </div>
      </div>
      {items === null ? (
        <div className="pad muted">Loading…</div>
      ) : items.length === 0 ? (
        <p className="pad muted" style={{ fontSize: 13 }}>
          No salary payments recorded yet. Use “Record payment” on a staff member after paying them.
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Date</th><th>Staff</th><th>Position</th><th style={{ textAlign: 'right' }}>Amount</th><th>Note</th></tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td className="muted">{fmtDate(p.paidOn)}</td>
                <td style={{ fontWeight: 600 }}>{p.staffName}</td>
                <td className="muted">{p.position ?? '—'}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(p.amount)}</td>
                <td className="muted">{p.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── record salary payment (confirmation flow) ──────────── */
function SalaryPaymentModal({
  member,
  onClose,
  onSaved,
}: {
  member: StaffFull;
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = useState(member.salaryAmount ?? 0);
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await staffApi.recordSalaryPayment(member.id, {
        amount,
        paidOn: date,
        note: note.trim() || undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the payment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Record salary payment"
      subtitle={`Do you want to record that you paid ${member.fullName}${member.position ? ` (${member.position})` : ''}? This only logs the payment — no money moves.`}
      onClose={onClose}
    >
      <form className="modal__body" onSubmit={submit}>
        <div className="grid2">
          <label className="field">
            <span>Amount (€)</span>
            <input type="number" min={1} value={amount || ''}
              onChange={(e) => setAmount(Number(e.target.value))} required />
          </label>
          <label className="field">
            <span>Date paid</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
        </div>
        <label className="field">
          <span>Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Optional — e.g. June salary" maxLength={300} />
        </label>
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Recording…' : `Yes, record ${formatMoney(amount || 0)}`}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/* ── add / edit staff ───────────────────────────────────── */
function StaffModal({
  member,
  selfId,
  onClose,
  onSaved,
}: {
  member?: StaffFull;
  selfId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(member);
  const isSelf = member?.id === selfId;
  const [fullName, setFullName] = useState(member?.fullName ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'owner' | 'frontdesk'>(member?.role ?? 'frontdesk');
  const [position, setPosition] = useState(member?.position ?? '');
  const [salaryAmount, setSalaryAmount] = useState<string>(
    member?.salaryAmount ? String(member.salaryAmount) : '',
  );
  const [salaryNote, setSalaryNote] = useState(member?.salaryNote ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (editing) {
        await staffApi.update(member!.id, {
          fullName,
          ...(isSelf ? {} : { role }),
          position: position.trim() || null,
          salaryAmount: salaryAmount ? Number(salaryAmount) : null,
          salaryNote: salaryNote.trim() || null,
        });
      } else {
        await staffApi.create({
          fullName, email, password, role,
          position: position.trim() || undefined,
          salaryAmount: salaryAmount ? Number(salaryAmount) : undefined,
          salaryNote: salaryNote.trim() || undefined,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save staff member.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={editing ? 'Edit staff member' : 'Add staff member'}
      subtitle={editing ? member!.email : 'They sign in with the temporary password you set here.'}
      onClose={onClose}
    >
      <form className="modal__body" onSubmit={submit}>
        <div className="grid2">
          <label className="field">
            <span>Full name</span>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} />
          </label>
          <label className="field">
            <span>Position / job title</span>
            <input value={position} onChange={(e) => setPosition(e.target.value)}
              placeholder="e.g. Dentist, Assistant, Manager" maxLength={80} />
          </label>
        </div>
        {!editing && (
          <div className="grid2">
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="name@clinic.com" required />
            </label>
            <label className="field">
              <span>Temporary password</span>
              <input value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="min 8 characters" required minLength={8} />
            </label>
          </div>
        )}
        <label className="field">
          <span>Access role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'frontdesk')}
            disabled={isSelf}>
            <option value="frontdesk">Frontdesk</option>
            <option value="owner">Owner</option>
          </select>
          <span className="muted" style={{ fontSize: 12 }}>
            {isSelf
              ? 'You cannot change your own access role.'
              : 'Access is Owner or Frontdesk only — “position” above is descriptive and grants no permissions.'}
          </span>
        </label>
        <div className="grid2">
          <label className="field">
            <span>Salary (€ / month)</span>
            <input type="number" min={1} value={salaryAmount}
              onChange={(e) => setSalaryAmount(e.target.value)} placeholder="Optional" />
          </label>
          <label className="field">
            <span>Salary note</span>
            <input value={salaryNote} onChange={(e) => setSalaryNote(e.target.value)}
              placeholder="Optional — e.g. net, paid on the 5th" maxLength={300} />
          </label>
        </div>
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add staff member'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
