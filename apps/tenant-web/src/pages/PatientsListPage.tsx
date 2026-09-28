import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search, Users, UserPlus } from 'lucide-react';
import { api, type PatientListItem } from '../lib/api';
import {
  Avatar,
  PageHeader,
  StatusPill,
  EmptyState,
  LoadingRows,
} from '../components/ui';
import { useAuth } from '../lib/auth';
import { dateLocale } from '../lib/strings';
import { formatMoney, plural } from '../lib/format';
import { toWall, wallNow } from '../lib/clinic-time';

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

const PAGE_SIZE = 20;

/** "Today 10:00", "Tomorrow 09:30", "Mon 12 Oct, 10:00" — on the clinic's clock. */
function fmtNext(iso: string) {
  const at = toWall(iso);
  const today = wallNow();
  today.setHours(0, 0, 0, 0);
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  return `${at.toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

/** What they owe, loudly; nothing owed, quietly; credit, in words. */
function Owes({ balance }: { balance: number }) {
  if (balance > 0) return <strong className="owes">{formatMoney(balance)}</strong>;
  if (balance < 0) return <span className="muted">Credit {formatMoney(-balance)}</span>;
  return (
    <span className="muted" aria-label="Nothing owed">
      —
    </span>
  );
}

export default function PatientsListPage() {
  const navigate = useNavigate();
  const { readOnly, can } = useAuth();
  const [searchParams] = useSearchParams();
  const linkedQ = searchParams.get('q');
  // A term handed over from the topbar search looks across every live record,
  // not only active ones — the person was searching for somebody specific.
  const [status, setStatus] = useState<'active' | 'inactive' | 'archived' | 'all'>(
    linkedQ ? 'all' : 'active',
  );
  const [q, setQ] = useState(linkedQ ?? '');
  const [debouncedQ, setDebouncedQ] = useState(linkedQ ?? '');

  // The topbar can hand over a new term while this page is already open.
  useEffect(() => {
    if (linkedQ === null) return;
    setQ(linkedQ);
    setDebouncedQ(linkedQ);
    setStatus('all');
  }, [linkedQ]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: PatientListItem[]; total: number } | null>(
    null,
  );
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

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE)),
    [data],
  );
  const firstShown = (page - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(page * PAGE_SIZE, data?.total ?? 0);
  const tabLabel = TABS.find((x) => x.key === status)?.label ?? '';
  // The columns follow what this role may see; the API leaves the rest out.
  const showNext = data?.items.some((p) => p.nextAppointmentAt !== undefined) ?? false;
  const showBalance = data?.items.some((p) => p.balance !== undefined) ?? false;

  return (
    <div className="page">
      <PageHeader
        title="Patients"
        meta={data ? `${plural(data.total, 'patient')} · ${tabLabel}` : undefined}
        actions={
          // Import lives in the section tabs above; one primary action here.
          !readOnly && can('patients:write') ? (
            <Link to="/patients/new" className="btn btn--primary">
              <UserPlus size={16} aria-hidden /> Add patient
            </Link>
          ) : undefined
        }
      />

      <section className="card">
        <div className="card__toolbar">
          <div className="tabs" role="group" aria-label="Filter patients by status">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`tab${status === tab.key ? ' tab--active' : ''}`}
                aria-pressed={status === tab.key}
                onClick={() => setStatus(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <label className="searchbox">
            <Search size={16} aria-hidden />
            <span className="sr-only">Search patients</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, phone, email…"
            />
          </label>
        </div>

        {loading && !data ? (
          <LoadingRows rows={3} label="Loading patients" />
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
                  <UserPlus size={16} aria-hidden /> Add your first patient
                </Link>
              ) : undefined
            }
          />
        ) : (
          <table className="table" aria-busy={loading}>
            <thead>
              <tr>
                <th scope="col">Patient</th>
                <th scope="col" className="hide-sm">
                  Phone
                </th>
                {showNext && (
                  <th scope="col" className="hide-sm">
                    Next visit
                  </th>
                )}
                {showBalance && (
                  <th scope="col" className="hide-sm table__num">
                    Balance
                  </th>
                )}
                {status === 'all' && <th scope="col">Status</th>}
                <th scope="col" className="table__chevron">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr
                  key={p.id}
                  className="trow"
                  onClick={() => navigate(`/patients/${p.id}`)}
                >
                  <td>
                    <div className="namecell">
                      <Avatar name={`${p.firstName} ${p.lastName}`} size={36} />
                      <span className="namecell__text">
                        <Link
                          to={`/patients/${p.id}`}
                          className="table__link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.firstName} {p.lastName}
                        </Link>
                        {/* On a phone: when they are next in, and what they owe. */}
                        <span className="namecell__sub only-sm">
                          {[
                            p.nextAppointmentAt
                              ? `Next ${fmtNext(p.nextAppointmentAt)}`
                              : null,
                            p.balance && p.balance > 0
                              ? `Owes ${formatMoney(p.balance)}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') ||
                            p.phone ||
                            'No phone on file'}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="muted hide-sm">{p.phone ?? '—'}</td>
                  {showNext && (
                    <td className="hide-sm">
                      {p.nextAppointmentAt ? (
                        fmtNext(p.nextAppointmentAt)
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  )}
                  {showBalance && (
                    <td className="hide-sm table__num">
                      <Owes balance={p.balance ?? 0} />
                    </td>
                  )}
                  {status === 'all' && (
                    <td>
                      <StatusPill status={p.status} />
                    </td>
                  )}
                  <td className="table__chevron">
                    <ChevronRight size={16} aria-hidden />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {data && data.total > 0 && (
          <div className="card__foot">
            <span>
              Showing {firstShown}–{lastShown} of {data.total}
            </span>
            {totalPages > 1 && (
              <div className="toolbar__group">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft size={15} aria-hidden /> Previous
                </button>
                <span>
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next <ChevronRight size={15} aria-hidden />
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
