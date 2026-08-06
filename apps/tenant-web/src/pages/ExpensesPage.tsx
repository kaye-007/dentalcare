import { useEffect, useState, type FormEvent } from 'react';
import { Plus, TrendingDown, Trash2 } from 'lucide-react';
import {
  financeApi,
  ApiError,
  type ExpenseRow,
  type ExpenseCategory,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader, StatusPill, EmptyState, Modal } from '../components/ui';
import { formatMoney } from '../lib/format';

const CATEGORIES: { key: ExpenseCategory; label: string }[] = [
  { key: 'rent', label: 'Rent' },
  { key: 'materials', label: 'Materials' },
  { key: 'utilities', label: 'Utilities' },
  { key: 'salaries', label: 'Salaries' },
  { key: 'lab', label: 'Lab' },
  { key: 'other', label: 'Other' },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ExpensesPage() {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const [category, setCategory] = useState('all');
  const [items, setItems] = useState<ExpenseRow[] | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    setItems(await financeApi.listExpenses(category));
  }
  useEffect(() => {
    setItems(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  const total = (items ?? []).reduce((s, e) => s + e.amount, 0);

  async function remove(id: string) {
    try {
      await financeApi.deleteExpense(id);
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Could not delete.');
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Expenses"
        meta={items ? `${items.length} entr${items.length === 1 ? 'y' : 'ies'} · ${formatMoney(total)} in view` : '…'}
        actions={
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Add expense
          </button>
        }
      />

      <div className="toolbar">
        <div className="tabs">
          <button className={`tab${category === 'all' ? ' tab--active' : ''}`} onClick={() => setCategory('all')}>
            All
          </button>
          {CATEGORIES.map((c) => (
            <button key={c.key} className={`tab${category === c.key ? ' tab--active' : ''}`}
              onClick={() => setCategory(c.key)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        {items === null ? (
          <div className="pad muted">Loading…</div>
        ) : items.length === 0 ? (
          <EmptyState icon={<TrendingDown size={22} />} title="No expenses recorded"
            body="Log clinic costs so the owner's profit picture is real." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th><th>Category</th><th>Note</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                {isOwner && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="muted">{fmtDate(e.expenseDate)}</td>
                  <td><StatusPill status="neutral" label={CAT_LABEL[e.category]} /></td>
                  <td className="muted">{e.note ?? '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(e.amount)}</td>
                  {isOwner && (
                    <td style={{ textAlign: 'right' }}>
                      <button className="note__del" onClick={() => remove(e.id)} title="Delete expense">
                        <Trash2 size={13} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <ExpenseModal
          onClose={() => setCreating(false)}
          onSaved={async () => { setCreating(false); await load(); }}
        />
      )}
    </div>
  );
}

function ExpenseModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [category, setCategory] = useState<ExpenseCategory>('materials');
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await financeApi.createExpense({
        category,
        amount,
        expenseDate: date,
        note: note.trim() || undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save expense.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add expense" onClose={onClose}>
      <form className="modal__body" onSubmit={submit}>
        <div className="grid2">
          <label className="field">
            <span>Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
              {CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Amount (€)</span>
            <input type="number" min={1} value={amount || ''}
              onChange={(e) => setAmount(Number(e.target.value))} required />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>Note</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" maxLength={300} />
          </label>
        </div>
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Add expense'}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
