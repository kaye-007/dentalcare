import { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { api, humanError, type PatientListItem, type PatientPayload } from '../lib/api';
import { Avatar } from './ui';

/** "Ana Maria Hoxha" → first "Ana Maria", last "Hoxha": the last word is the surname. */
function splitName(q: string) {
  const words = q.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { first: words[0] ?? '', last: '' };
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1]! };
}

export default function PatientPicker({
  value,
  onPick,
  onClear,
  canCreate = false,
}: {
  value: string;
  onPick: (p: PatientListItem) => void;
  onClear: () => void;
  /** Offer "New patient" when the search finds nobody — the first call from someone new. */
  canCreate?: boolean;
}) {
  const [q, setQ] = useState(value);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PatientListItem[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setQ(value), [value]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api
        .listPatients({ q, status: 'active' })
        .then((d) => setResults(d.items.slice(0, 8)))
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  function startAdding() {
    const looksLikePhone = /^[+\d][\d\s-]{5,}$/.test(q.trim());
    const n = looksLikePhone ? { first: '', last: '' } : splitName(q);
    setFirst(n.first);
    setLast(n.last);
    setPhone(looksLikePhone ? q.trim() : '');
    setError(null);
    setAdding(true);
    setOpen(false);
  }

  async function create() {
    if (!first.trim() || !last.trim()) {
      setError('A first and a last name are needed.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const p = await api.createPatient({
        firstName: first.trim(),
        lastName: last.trim(),
        phone: phone.trim(),
      } as PatientPayload);
      setAdding(false);
      onPick({
        ...(p as unknown as PatientListItem),
        firstName: p.firstName,
        lastName: p.lastName,
      });
    } catch (err) {
      setError(humanError(err, 'The patient could not be added. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  const term = q.trim();

  return (
    <>
      <label className="field picker">
        <span>Patient</span>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setAdding(false);
            onClear();
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search patient by name or phone…"
          autoComplete="off"
        />
        {open && (
          <div className="picker__menu">
            {results !== null && results.length === 0 && (
              <div className="picker__none">No matching patients</div>
            )}
            {(results ?? []).map((p) => (
              <button
                type="button"
                className="picker__opt"
                key={p.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(p);
                  setOpen(false);
                }}
              >
                <Avatar name={`${p.firstName} ${p.lastName}`} size={26} />
                <span>
                  {p.firstName} {p.lastName}
                </span>
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                  {p.phone ?? ''}
                </span>
              </button>
            ))}
            {canCreate && term.length >= 2 && (
              <button
                type="button"
                className="picker__opt picker__new"
                onMouseDown={(e) => e.preventDefault()}
                onClick={startAdding}
              >
                <UserPlus size={16} aria-hidden />
                <span>New patient “{term}”</span>
              </button>
            )}
          </div>
        )}
      </label>

      {/* Just enough to book: a name and a way to call. The rest of the
          record can be filled in when they arrive. */}
      {adding && (
        <div className="quickpatient">
          <p className="quickpatient__title">New patient</p>
          <div className="grid2">
            <label className="field">
              <span>First name</span>
              <input value={first} onChange={(e) => setFirst(e.target.value)} autoFocus />
            </label>
            <label className="field">
              <span>Last name</span>
              <input value={last} onChange={(e) => setLast(e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>Phone</span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="068 123 4567"
            />
          </label>
          {error && <p className="formerror">{error}</p>}
          <div className="quickpatient__foot">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() => void create()}
            >
              {busy ? 'Adding…' : 'Add and use'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
