import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Search } from 'lucide-react';
import {
  api,
  type ActivityCategory,
  type ActivityCursor,
  type ActivityEntry,
  type Plan,
} from '../lib/api';
import { dayHeading, describe, subjectOf } from '../lib/activity';
import { fmtTime } from '../lib/format';
import { Empty, SkeletonRows } from '../components/ui';

type Filter = 'all' | ActivityCategory;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'clinics', label: 'Clinics' },
  { key: 'billing', label: 'Billing' },
  { key: 'plans', label: 'Plans' },
];

const PAGE = 50;

/**
 * Everything the console has done, across every clinic, newest first.
 *
 * Each clinic's page shows its own slice of this trail. This is the whole of
 * it — the screen for "who suspended that clinic on Tuesday" without first
 * having to guess which clinic.
 */
export default function ActivityPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState<ActivityEntry[] | null>(null);
  const [next, setNext] = useState<ActivityCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [plans, setPlans] = useState<Plan[]>([]);
  // Switching filters while a page is in flight must not append the old
  // filter's rows to the new one's list.
  const generation = useRef(0);

  const category = filter === 'all' ? undefined : filter;

  const loadFirst = useCallback(() => {
    const gen = ++generation.current;
    setRows(null);
    api
      .activity({ category, limit: PAGE })
      .then((page) => {
        if (gen !== generation.current) return;
        setRows(page.rows);
        setNext(page.next);
        setError(null);
      })
      .catch((e: Error) => gen === generation.current && setError(e.message));
  }, [category]);
  useEffect(loadFirst, [loadFirst]);

  useEffect(() => {
    api
      .plans()
      .then(setPlans)
      .catch(() => setPlans([]));
  }, []);

  async function loadMore() {
    if (!next) return;
    const gen = generation.current;
    setLoadingMore(true);
    try {
      const page = await api.activity({ category, limit: PAGE, cursor: next });
      if (gen !== generation.current) return;
      setRows((r) => [...(r ?? []), ...page.rows]);
      setNext(page.next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  const planMap = useMemo(() => new Map(plans.map((p) => [p.id, p.name])), [plans]);

  // The search narrows what is loaded; "Load more" still pages the server.
  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!rows || !term) return rows;
    return rows.filter((e) => {
      const d = describe(e, planMap);
      return [
        d.verb,
        d.detail,
        subjectOf(e),
        e.actor_label,
        e.subdomain,
        e.invoice_number,
      ]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(term));
    });
  }, [rows, q, planMap]);

  let lastDay = '';

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page__head">
        <div className="page__head-main">
          <h1 className="page__title">Activity</h1>
          <p className="page__meta">
            Everything done in the console, by whom and when. Nothing here can be edited.
          </p>
        </div>
      </div>

      <section className="card">
        <div className="card__toolbar">
          <div className="tabs" role="tablist" aria-label="Filter activity">
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
              </button>
            ))}
          </div>
          <label className="searchbox" style={{ width: 260 }}>
            <Search size={15} aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Clinic, person or detail"
              aria-label="Search activity"
            />
          </label>
        </div>

        {error && <p className="pad formerror">{error}</p>}

        {visible === null ? (
          <SkeletonRows rows={6} />
        ) : visible.length === 0 ? (
          <Empty
            icon={Activity}
            title={q ? 'Nothing matches' : 'Nothing recorded yet'}
            body={
              q
                ? next
                  ? 'Only loaded entries are searched — load more to search further back.'
                  : undefined
                : 'Every console action is recorded here as it happens.'
            }
          />
        ) : (
          <ul className="feed">
            {visible.flatMap((e) => {
              const d = describe(e, planMap);
              const subject = subjectOf(e);
              const day = dayHeading(e.created_at);
              const header = day !== lastDay ? day : null;
              lastDay = day;
              return [
                header && (
                  <li key={`day-${e.id}`} className="feed__day">
                    {header}
                  </li>
                ),
                <li key={e.id} className="feed__item">
                  <span className={`feed__icon feed__icon--${d.tone}`}>
                    <d.icon size={14} aria-hidden />
                  </span>
                  <div className="feed__body">
                    <span className="feed__title">
                      {d.verb}{' '}
                      {subject &&
                        (e.tenant_id ? (
                          <Link
                            to={`/tenants/${e.tenant_id}${e.entity_type === 'subscription_invoice' ? '?tab=billing' : ''}`}
                          >
                            {subject}
                          </Link>
                        ) : e.entity_type === 'plan' ? (
                          <Link to="/plans">{subject}</Link>
                        ) : (
                          <b>{subject}</b>
                        ))}
                    </span>
                    {d.detail && <span className="feed__detail">{d.detail}</span>}
                    <span className="feed__meta">
                      {e.actor_label ?? 'System'} · {fmtTime(e.created_at)}
                    </span>
                  </div>
                </li>,
              ];
            })}
          </ul>
        )}

        {next && visible !== null && (
          <div className="feed__more">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load older entries'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
