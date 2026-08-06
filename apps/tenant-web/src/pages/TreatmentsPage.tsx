import { useEffect, useState, type FormEvent } from 'react';
import { Plus, Search, Stethoscope, Pencil } from 'lucide-react';
import {
  treatmentsApi,
  ApiError,
  type Treatment,
  type TreatmentPayload,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader, StatusPill, EmptyState, Modal } from '../components/ui';
import { formatMoney } from '../lib/format';

const TABS = [
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
  { key: 'all', label: 'All' },
] as const;

export default function TreatmentsPage() {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState<Treatment[] | null>(null);
  const [editing, setEditing] = useState<Treatment | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  async function load() {
    setItems(await treatmentsApi.list({ q: debouncedQ, status }));
  }
  useEffect(() => {
    setItems(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, debouncedQ]);

  return (
    <div className="page">
      <PageHeader
        title="Treatments"
        meta={items ? `${items.length} in catalogue` : '…'}
        actions={
          isOwner ? (
            <button className="btn btn--primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> Add treatment
            </button>
          ) : undefined
        }
      />

      <div className="toolbar">
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab${status === t.key ? ' tab--active' : ''}`} onClick={() => setStatus(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="searchbox">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search treatments…" />
        </div>
      </div>

      <div className="card">
        {items === null ? (
          <div className="pad muted">Loading…</div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Stethoscope size={22} />}
            title="No treatments found"
            body={isOwner ? 'Add your first treatment to build the catalogue.' : 'The owner manages the treatment catalogue.'}
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Treatment</th>
                <th>Price</th>
                <th>Duration</th>
                <th>Visit type</th>
                <th>Status</th>
                {isOwner && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td><span style={{ fontWeight: 600 }}>{t.name}</span></td>
                  <td>from {formatMoney(t.price)}</td>
                  <td className="muted">± {t.durationMinutes} min</td>
                  <td>
                    {t.visitType ? (
                      <StatusPill
                        status={t.visitType === 'single' ? 'info' : 'warn'}
                        label={t.visitType === 'single' ? 'Single visit' : 'Multiple visits'}
                      />
                    ) : (
                      <span className="muted">Not specified</span>
                    )}
                  </td>
                  <td><StatusPill status={t.status} /></td>
                  {isOwner && (
                    <td style={{ textAlign: 'right' }}>
                      <button className="iconbtn" style={{ width: 30, height: 30 }} onClick={() => setEditing(t)} title="Edit">
                        <Pencil size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(creating || editing) && (
        <TreatmentModal
          treatment={editing ?? undefined}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={async () => { setCreating(false); setEditing(null); await load(); }}
        />
      )}
    </div>
  );
}

function TreatmentModal({
  treatment,
  onClose,
  onSaved,
}: {
  treatment?: Treatment;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(treatment);
  const [form, setForm] = useState<TreatmentPayload>({
    name: treatment?.name ?? '',
    price: treatment?.price ?? 0,
    durationMinutes: treatment?.durationMinutes ?? 60,
    visitType: treatment?.visitType ?? null,
    status: treatment?.status ?? 'active',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (editing) await treatmentsApi.update(treatment!.id, form);
      else await treatmentsApi.create(form);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save treatment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? 'Edit treatment' : 'New treatment'} onClose={onClose}>
      <form className="modal__body" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Tooth Filling" required />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Price (€)</span>
            <input type="number" min={0} value={form.price}
              onChange={(e) => setForm((f) => ({ ...f, price: Number(e.target.value) }))} required />
          </label>
          <label className="field">
            <span>Duration (minutes)</span>
            <input type="number" min={5} max={600} step={5} value={form.durationMinutes}
              onChange={(e) => setForm((f) => ({ ...f, durationMinutes: Number(e.target.value) }))} required />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Visit type <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></span>
            <select value={form.visitType ?? ''}
              onChange={(e) => setForm((f) => ({
                ...f,
                visitType: e.target.value === '' ? null : (e.target.value as 'single' | 'multiple'),
              }))}>
              <option value="">Not specified</option>
              <option value="single">Single visit</option>
              <option value="multiple">Multiple visits</option>
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select value={form.status}
              onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as 'active' | 'inactive' }))}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
        </div>
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add treatment'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
