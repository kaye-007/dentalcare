import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search, Users, UserPlus } from 'lucide-react';
import { api, type PatientListItem } from '../lib/api';
import { Avatar, PageHeader, StatusPill, EmptyState } from '../components/ui';
import { useAuth } from '../lib/auth';
import { dateLocale } from '../lib/i18n';

/**
 * 'all' means all *live* records — the API excludes archived patients unless
 * they are asked for explicitly, so reaching them needs its own tab.
 */
const TABS = [
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
  { key: 'all', label: 'All' },
  { key: 'archived', label: 'Archived' },
] as const;

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function PatientsListPage() {
  const navigate = useNavigate();
  const { readOnly } = useAuth();
  const [status, setStatus] = useState<'active' | 'inactive' | 'archived' | 'all'>('active');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: PatientListItem[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [status, debouncedQ]);

  useEffect(() => {
    let off = false;
    setLoading(true);
    api
      .listPatients({ q: debouncedQ, status, page })
      .then((d) => !off && setData({ items: d.items, total: d.total }))
      .finally(() => !off && setLoading(false));
    return () => {
      off = true;
    };
  }, [status, debouncedQ, page]);

  const pageSize = 20;
  const totalPages = useMemo(() => Math.max(1, Math.ceil((data?.total ?? 0) / pageSize)), [data]);

  return (
    <div className="page">
      <PageHeader
        title="Patients"
        meta={`${data?.total ?? 0} total`}
        actions={
          <Link to="/patients/new" className="btn btn--primary">
            <Plus size={16} /> Add patient
          </Link>
        }
      />

      <div className="toolbar">
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab${status === t.key ? ' tab--active' : ''}`}
              onClick={() => setStatus(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="searchbox">
          <Search size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, phone, email…"
          />
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="pad muted">Loading…</div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            icon={<Users size={22} />}
            title={debouncedQ ? 'No patients found' : 'No patients yet'}
            body={
              debouncedQ
                ? 'Try a different search.'
                : 'Start with a name and a phone number — everything else can be filled in later.'
            }
            action={
              // Not while searching: the answer to an empty search is a
              // different search, not a new patient record.
              !debouncedQ && !readOnly ? (
                <Link to="/patients/new" className="btn btn--primary">
                  <UserPlus size={16} /> Add your first patient
                </Link>
              ) : undefined
            }
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Phone</th>
                <th>Email</th>
                <th>City</th>
                <th>Status</th>
                <th>Registered</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className="trow" onClick={() => navigate(`/patients/${p.id}`)}>
                  <td>
                    <div className="namecell">
                      <Avatar name={`${p.firstName} ${p.lastName}`} size={32} />
                      <span>{p.firstName} {p.lastName}</span>
                    </div>
                  </td>
                  <td className="muted">{p.phone ?? '—'}</td>
                  <td className="muted">{p.email ?? '—'}</td>
                  <td className="muted">{p.city ?? '—'}</td>
                  <td><StatusPill status={p.status} /></td>
                  <td className="muted">{fmtDate(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && totalPages > 1 && (
        <div className="pager">
          <button className="btn btn--ghost btn--sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span className="muted">Page {page} of {totalPages}</span>
          <button className="btn btn--ghost btn--sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
