import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import type { Treatment } from '../lib/api';
import { formatMoney } from '../lib/format';

/**
 * Pick what was done from the clinic's own service catalogue.
 *
 * A bill is built by choosing services, not by typing them: the price, the
 * name and the TVSH category then come from the catalogue the owner
 * maintains, and the same work is priced the same way every time. A plain
 * dropdown of names did not carry the price, which is the one thing reception
 * checks before adding a line, and became unusable past a handful of entries.
 *
 * A custom line stays available for the exception the catalogue has not met
 * yet — deliberate, and one tap further away.
 */
export default function ServicePicker({
  treatments,
  onAdd,
  onAddCustom,
}: {
  treatments: Treatment[];
  onAdd: (t: Treatment) => void;
  onAddCustom: () => void;
}) {
  const [q, setQ] = useState('');

  const matches = useMemo(() => {
    const term = q.trim().toLowerCase();
    const active = treatments.filter((t) => t.status === 'active');
    return term ? active.filter((t) => t.name.toLowerCase().includes(term)) : active;
  }, [treatments, q]);

  return (
    <div className="svcpick">
      <label className="svcpick__search">
        <Search size={15} aria-hidden />
        <span className="sr-only">Search services</span>
        <input
          type="search"
          value={q}
          placeholder="Search services…"
          autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
        />
      </label>

      {treatments.length === 0 ? (
        <p className="svcpick__empty">
          No services in the catalogue yet.{' '}
          <Link to="/treatments">Add them under Treatments</Link>, or use a custom line.
        </p>
      ) : matches.length === 0 ? (
        <p className="svcpick__empty">No service matches “{q.trim()}”.</p>
      ) : (
        <ul className="svcpick__list">
          {matches.map((t) => (
            <li key={t.id}>
              <button type="button" className="svcpick__item" onClick={() => onAdd(t)}>
                <span className="svcpick__name">{t.name}</span>
                <span className="svcpick__price">{formatMoney(t.price)}</span>
                <Plus size={15} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="link svcpick__custom" onClick={onAddCustom}>
        <Plus size={14} aria-hidden /> Custom line
      </button>
    </div>
  );
}
