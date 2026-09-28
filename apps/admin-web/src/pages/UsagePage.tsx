import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays,
  Download,
  Files,
  HardDrive,
  RefreshCw,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
import { api, formatBytes, type FleetUsage, type TenantUsageRow } from '../lib/api';
import { daysSince, downloadCsv, fmtNumber, plural, stamp } from '../lib/format';
import { ShareBars } from '../components/charts';
import {
  ClinicMark,
  Empty,
  Kpi,
  SkeletonRows,
  SortHeader,
  useSort,
} from '../components/ui';

/**
 * What the fleet is consuming, and which clinics are the outliers.
 *
 * Sorted by storage because storage is the one resource with a real marginal
 * cost. Everything else here is a health signal rather than a bill: a clinic
 * with 400 patients and no session in six weeks is churning, whatever its
 * subscription says.
 */

type SortKey =
  'name' | 'storageBytes' | 'patients' | 'appointments30d' | 'users' | 'lastActivity';

const QUIET_DAYS = 30;

const SORTERS: Record<SortKey, (a: TenantUsageRow, b: TenantUsageRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  storageBytes: (a, b) => a.storageBytes - b.storageBytes,
  patients: (a, b) => a.patients - b.patients,
  appointments30d: (a, b) => a.appointments30d - b.appointments30d,
  users: (a, b) => a.users - b.users,
  lastActivity: (a, b) =>
    (a.lastActivity ? Date.parse(a.lastActivity) : 0) -
    (b.lastActivity ? Date.parse(b.lastActivity) : 0),
};

export default function UsagePage() {
  const [usage, setUsage] = useState<FleetUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const { sort, onSort } = useSort<SortKey>('storageBytes', 'desc', ['name']);

  const load = useCallback(() => {
    api
      .usage()
      .then((u) => {
        setUsage(u);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const cmp = SORTERS[sort.key];
    return (usage?.tenants ?? [])
      .filter(
        (t) => !term || t.name.toLowerCase().includes(term) || t.subdomain.includes(term),
      )
      .sort((a, b) => (sort.dir === 'asc' ? cmp(a, b) : cmp(b, a)));
  }, [usage, q, sort]);

  const peak = Math.max(1, ...(usage?.tenants ?? []).map((t) => t.storageBytes));

  function exportCsv() {
    downloadCsv(
      `usage-${stamp()}.csv`,
      [
        'Clinic',
        'Subdomain',
        'Status',
        'Plan',
        'Users',
        'Patients',
        'Appointments (all time)',
        'Appointments (30 days)',
        'Invoices',
        'Documents',
        'Storage (bytes)',
        'Last activity',
      ],
      rows.map((t) => [
        t.name,
        t.subdomain,
        t.status,
        t.planName,
        t.users,
        t.patients,
        t.appointments,
        t.appointments30d,
        t.invoices,
        t.documents,
        t.storageBytes,
        t.lastActivity?.slice(0, 10) ?? null,
      ]),
    );
  }

  return (
    <div className="page">
      <div className="page__head">
        <div className="page__head-main">
          <h1 className="page__title">Usage &amp; storage</h1>
          <p className="page__meta">
            What every clinic is consuming, and which ones have gone quiet.
          </p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="iconbtn"
            onClick={load}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={exportCsv}
            disabled={!rows.length}
          >
            <Download size={15} aria-hidden /> Export CSV
          </button>
        </div>
      </div>

      {error && (
        <p className="formerror" style={{ marginBottom: 16 }}>
          {error}
        </p>
      )}

      {usage ? (
        <>
          <div className="kpis">
            <Kpi
              label="Stored"
              icon={HardDrive}
              value={formatBytes(usage.totals.storageBytes)}
              note={`${fmtNumber(usage.totals.documents)} files`}
            />
            <Kpi
              label="Patients"
              icon={Users}
              value={fmtNumber(usage.totals.patients)}
              note={`${fmtNumber(usage.totals.users)} staff across ${plural(usage.totals.clinics, 'clinic')}`}
            />
            <Kpi
              label="Appointments"
              icon={CalendarDays}
              value={fmtNumber(usage.totals.appointments)}
              note={`${fmtNumber(usage.totals.invoices)} clinic invoices, all time`}
            />
            <Kpi
              label="Reclaimable"
              icon={Trash2}
              tone={usage.reclaimable.bytes ? 'warn' : undefined}
              value={formatBytes(usage.reclaimable.bytes)}
              note={`${fmtNumber(usage.reclaimable.files)} deleted files, not yet purged`}
            />
          </div>

          {usage.backend && <StorageBackend backend={usage.backend} />}

          <section className="card">
            <div className="card__toolbar">
              <h2 style={{ margin: 0, fontSize: 15.5, fontWeight: 600 }}>By clinic</h2>
              <label className="searchbox" style={{ width: 240 }}>
                <Search size={15} aria-hidden />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Find a clinic"
                  aria-label="Find a clinic"
                />
              </label>
            </div>
            {rows.length === 0 ? (
              <Empty
                compact
                icon={Search}
                title={q ? 'No clinics match' : 'No clinics yet'}
              />
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <SortHeader label="Clinic" k="name" sort={sort} onSort={onSort} />
                      <SortHeader
                        label="Storage"
                        k="storageBytes"
                        sort={sort}
                        onSort={onSort}
                      />
                      <SortHeader
                        label="Patients"
                        k="patients"
                        sort={sort}
                        onSort={onSort}
                        numeric
                      />
                      <SortHeader
                        label="Appts 30d"
                        k="appointments30d"
                        sort={sort}
                        onSort={onSort}
                        numeric
                      />
                      <SortHeader
                        label="Users"
                        k="users"
                        sort={sort}
                        onSort={onSort}
                        numeric
                      />
                      <SortHeader
                        label="Last seen"
                        k="lastActivity"
                        sort={sort}
                        onSort={onSort}
                        numeric
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.tenantId}>
                        <td>
                          <div className="namecell">
                            <ClinicMark name={t.name} size={32} />
                            <div className="namecell__text">
                              <Link
                                to={`/tenants/${t.tenantId}`}
                                className="namecell__title"
                              >
                                {t.name}
                              </Link>
                              <span className="namecell__sub">
                                {t.planName ?? 'No plan'}
                                {t.status !== 'active' ? ` · ${t.status}` : ''}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td style={{ minWidth: 150 }}>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              gap: 8,
                            }}
                          >
                            <span>{formatBytes(t.storageBytes)}</span>
                            <span className="muted">{fmtNumber(t.documents)} files</span>
                          </div>
                          <span
                            className="meter"
                            style={{ marginTop: 6, height: 4 }}
                            aria-hidden
                          >
                            <span
                              className="meter__fill"
                              style={{ width: `${(t.storageBytes / peak) * 100}%` }}
                            />
                          </span>
                        </td>
                        <td className="num">{fmtNumber(t.patients)}</td>
                        <td className="num">{fmtNumber(t.appointments30d)}</td>
                        <td className="num">{t.users}</td>
                        <td className="num">
                          <LastSeen iso={t.lastActivity} active={t.status === 'active'} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {usage.storageByKind.length > 0 && (
            <section className="card">
              <div className="card__head">
                <div>
                  <h2>
                    <Files size={16} aria-hidden /> Where the bytes are
                  </h2>
                  <p className="card__sub">By kind of document</p>
                </div>
              </div>
              <ShareBars
                empty="Nothing stored yet."
                rows={usage.storageByKind.map((k) => ({
                  key: k.kind,
                  label: k.kind.replace(/_/g, ' '),
                  value: k.bytes,
                  display: formatBytes(k.bytes),
                  note: `${fmtNumber(k.files)} files`,
                }))}
              />
            </section>
          )}
        </>
      ) : (
        !error && (
          <div className="card">
            <SkeletonRows rows={5} />
          </div>
        )
      )}
    </div>
  );
}

/**
 * Days, not a date. "41 days ago" is a churn signal at a glance; "8 August"
 * requires the reader to do the subtraction.
 */
function LastSeen({ iso, active }: { iso: string | null; active: boolean }) {
  const days = daysSince(iso);
  if (days === null) return <span className="muted">never</span>;
  const label = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return active && days > QUIET_DAYS ? (
    <span className="pill pill--warn">{label}</span>
  ) : (
    <>{label}</>
  );
}

/**
 * Where the files physically are. On this server's own disk the free space is
 * the number to watch: when it runs out, every clinic's uploads stop at once.
 */
function StorageBackend({ backend }: { backend: NonNullable<FleetUsage['backend']> }) {
  if (backend.driver === 'off') {
    return (
      <p className="banner storagebar storagebar--off">
        Uploads are switched off on this server. Clinics cannot add documents, photos or
        logos until STORAGE_DRIVER is unset or a bucket is configured.
      </p>
    );
  }
  if (backend.driver === 's3') {
    return <p className="storagebar">Files are kept in the S3-compatible bucket.</p>;
  }
  const free = backend.diskFreeBytes;
  const total = backend.diskTotalBytes;
  const usedPct =
    free !== null && total ? Math.round(((total - free) / total) * 100) : null;
  const low = free !== null && total ? free / total < 0.1 : false;
  return (
    <div className={`storagebar${low ? ' storagebar--low' : ''}`}>
      <span>
        <strong>Files are kept on this server&rsquo;s disk.</strong>{' '}
        {free !== null && total
          ? `${formatBytes(free)} free of ${formatBytes(total)}.`
          : 'Free space could not be read.'}
        {low ? ' Space is running low — add disk or clean up soon.' : ''}
      </span>
      {usedPct !== null && (
        <span className="storagebar__meter" aria-hidden>
          <span style={{ width: `${usedPct}%` }} />
        </span>
      )}
    </div>
  );
}
