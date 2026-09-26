import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, ChevronRight, Download, Rocket, Search } from 'lucide-react';
import {
  api,
  clinicHost,
  formatBytes,
  formatEuro,
  trialState,
  type Plan,
  type PlatformOverview,
  type TenantRow,
  type TenantStatus,
} from '../lib/api';
import { downloadCsv, fmtDate, fmtNumber, stamp } from '../lib/format';
import {
  ClinicMark,
  Empty,
  SkeletonRows,
  SortHeader,
  STATUS_LABEL,
  StatusPill,
  TrialPill,
  useSort,
} from '../components/ui';
import { useShell } from '../components/shell';

type Filter = 'live' | 'trial' | TenantStatus;
type SortKey = 'name' | 'plan' | 'users' | 'patients' | 'appts' | 'storage' | 'created';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'live', label: 'All live' },
  { key: 'active', label: 'Active' },
  { key: 'trial', label: 'On trial' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'archived', label: 'Archived' },
  { key: 'deleted', label: 'Deleted' },
];

function onTrial(t: TenantRow) {
  return trialState(t.trial_ends_at).kind === 'running';
}

function matches(t: TenantRow, f: Filter) {
  if (f === 'live') return t.status !== 'deleted';
  if (f === 'trial') return t.status === 'active' && onTrial(t);
  return t.status === f;
}

const SORTERS: Record<SortKey, (a: TenantRow, b: TenantRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  plan: (a, b) => (a.price_monthly ?? -1) - (b.price_monthly ?? -1),
  users: (a, b) => a.active_user_count - b.active_user_count,
  patients: (a, b) => a.patient_count - b.patient_count,
  appts: (a, b) => a.appointments_this_month - b.appointments_this_month,
  storage: (a, b) => a.storage_bytes - b.storage_bytes,
  created: (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
};

/** Every clinic on the platform, with what it uses and where it stands. */
export default function TenantsPage() {
  const navigate = useNavigate();
  const { version, openCreate } = useShell();
  const [tenants, setTenants] = useState<TenantRow[] | null>(null);
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [filter, setFilter] = useState<Filter>('live');
  const [plan, setPlan] = useState<string>('any');
  const [q, setQ] = useState('');
  const { sort, onSort } = useSort<SortKey>('created', 'desc', ['name']);

  useEffect(() => {
    Promise.all([api.tenants(), api.plans(), api.overview()])
      .then(([t, p, o]) => {
        setTenants(t);
        setPlans(p);
        setOverview(o);
      })
      .catch(() => setTenants([]));
  }, [version]);

  const counts = useMemo(() => {
    const c = {} as Record<Filter, number>;
    for (const f of FILTERS)
      c[f.key] = (tenants ?? []).filter((t) => matches(t, f.key)).length;
    return c;
  }, [tenants]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    const rows = (tenants ?? []).filter(
      (t) =>
        matches(t, filter) &&
        (plan === 'any' || (plan === 'none' ? !t.plan_id : t.plan_id === plan)) &&
        (!term ||
          t.name.toLowerCase().includes(term) ||
          t.subdomain.includes(term) ||
          (t.owner_email ?? '').toLowerCase().includes(term)),
    );
    const cmp = SORTERS[sort.key];
    return rows.sort((a, b) => (sort.dir === 'asc' ? cmp(a, b) : cmp(b, a)));
  }, [tenants, filter, plan, q, sort]);

  function exportCsv() {
    downloadCsv(
      `clinics-${stamp()}.csv`,
      [
        'Clinic',
        'Address',
        'Owner',
        'Status',
        'Plan',
        'Price / month (EUR)',
        'Trial ends',
        'Active users',
        'Users',
        'Patients',
        'Appointments this month',
        'Storage (bytes)',
        'Created',
      ],
      visible.map((t) => [
        t.name,
        clinicHost(t.subdomain),
        t.owner_email,
        STATUS_LABEL[t.status],
        t.plan_name,
        t.price_monthly !== null ? t.price_monthly / 100 : null,
        t.trial_ends_at?.slice(0, 10) ?? null,
        t.active_user_count,
        t.user_count,
        t.patient_count,
        t.appointments_this_month,
        t.storage_bytes,
        t.created_at.slice(0, 10),
      ]),
    );
  }

  return (
    <div className="page">
      <div className="page__head">
        <div className="page__head-main">
          <h1 className="page__title">Clinics</h1>
          <p className="page__meta">
            {overview
              ? `${overview.clinics.active} active · ${overview.trials} on trial · ${fmtNumber(overview.patients)} patients across the fleet`
              : 'Every clinic on the platform, with what it uses.'}
          </p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={exportCsv}
            disabled={!visible.length}
          >
            <Download size={15} aria-hidden /> Export CSV
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => openCreate(true)}
          >
            <Rocket size={15} aria-hidden /> New demo
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card__toolbar">
          <div className="tabs" role="tablist" aria-label="Filter by status">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                className={`tab${filter === f.key ? ' tab--active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                {tenants && <span className="tab__count">{counts[f.key]}</span>}
              </button>
            ))}
          </div>
          <div className="toolbar__group">
            <select
              className="select"
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              aria-label="Filter by plan"
            >
              <option value="any">All plans</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="none">No plan</option>
            </select>
            <label className="searchbox">
              <Search size={15} aria-hidden />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Name, subdomain or owner"
                aria-label="Search clinics"
              />
            </label>
          </div>
        </div>

        {tenants === null ? (
          <SkeletonRows rows={6} />
        ) : visible.length === 0 ? (
          tenants.length === 0 ? (
            <Empty
              icon={Building2}
              title="No clinics yet"
              body="Create the first clinic, or a seven-day demo for a sales call."
              action={
                <>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => openCreate(true)}
                  >
                    New demo
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => openCreate(false)}
                  >
                    New clinic
                  </button>
                </>
              }
            />
          ) : (
            <Empty
              icon={Search}
              title="No clinics match"
              body="Try another name, or clear the filters."
            />
          )
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <SortHeader label="Clinic" k="name" sort={sort} onSort={onSort} />
                  <SortHeader label="Plan" k="plan" sort={sort} onSort={onSort} />
                  <th>Status</th>
                  <SortHeader
                    label="Users"
                    k="users"
                    sort={sort}
                    onSort={onSort}
                    numeric
                  />
                  <SortHeader
                    label="Patients"
                    k="patients"
                    sort={sort}
                    onSort={onSort}
                    numeric
                  />
                  <SortHeader
                    label="Appts / mo"
                    k="appts"
                    sort={sort}
                    onSort={onSort}
                    numeric
                  />
                  <SortHeader
                    label="Storage"
                    k="storage"
                    sort={sort}
                    onSort={onSort}
                    numeric
                  />
                  <SortHeader label="Created" k="created" sort={sort} onSort={onSort} />
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {visible.map((t) => (
                  <tr
                    key={t.id}
                    className="trow"
                    onClick={() => navigate(`/tenants/${t.id}`)}
                  >
                    <td>
                      <div className="namecell">
                        <ClinicMark name={t.name} />
                        <div className="namecell__text">
                          <Link
                            to={`/tenants/${t.id}`}
                            className="namecell__title"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {t.name}
                          </Link>
                          <span className="namecell__sub">
                            {clinicHost(t.subdomain)} · {t.owner_email ?? 'no owner'}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>
                      {t.plan_name ?? <span className="muted">—</span>}
                      {t.price_monthly ? (
                        <span className="cell-sub">{formatEuro(t.price_monthly)}/mo</span>
                      ) : null}
                    </td>
                    <td>
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 4,
                        }}
                      >
                        <StatusPill status={t.status} />
                        {t.status === 'active' && (
                          <TrialPill trialEndsAt={t.trial_ends_at} paidLabel={null} />
                        )}
                      </div>
                    </td>
                    <td className="num">
                      {t.active_user_count}
                      <span className="muted"> / {t.user_count}</span>
                    </td>
                    <td className="num">{fmtNumber(t.patient_count)}</td>
                    <td className="num">{fmtNumber(t.appointments_this_month)}</td>
                    <td className="num">{formatBytes(t.storage_bytes)}</td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {fmtDate(t.created_at)}
                    </td>
                    <td className="table__chevron">
                      <ChevronRight size={16} aria-hidden />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tenants && visible.length > 0 && (
          <div className="card__foot">
            <span>
              Showing {visible.length} of {tenants.length} clinic
              {tenants.length === 1 ? '' : 's'}
            </span>
            <span>
              {formatEuro(
                visible
                  .filter((t) => t.status === 'active' && !onTrial(t))
                  .reduce((s, t) => s + (t.price_monthly ?? 0), 0),
              )}{' '}
              a month from these
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
