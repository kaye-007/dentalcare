import { useEffect, useState } from 'react';
import { api, type PatientListItem } from '../lib/api';
import { Avatar } from './ui';

export default function PatientPicker({
  value,
  onPick,
  onClear,
}: {
  value: string;
  onPick: (p: PatientListItem) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState(value);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PatientListItem[]>([]);

  useEffect(() => setQ(value), [value]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api.listPatients({ q, status: 'active' }).then((d) => setResults(d.items.slice(0, 8)));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  return (
    <label className="field picker">
      <span>Patient</span>
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); onClear(); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search patient by name or phone…"
        autoComplete="off"
      />
      {open && (
        <div className="picker__menu">
          {results.length === 0 ? (
            <div className="picker__none">No matching patients</div>
          ) : (
            results.map((p) => (
              <button
                type="button"
                className="picker__opt"
                key={p.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(p); setOpen(false); }}
              >
                <Avatar name={`${p.firstName} ${p.lastName}`} size={26} />
                <span>{p.firstName} {p.lastName}</span>
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>{p.phone ?? ''}</span>
              </button>
            ))
          )}
        </div>
      )}
    </label>
  );
}
