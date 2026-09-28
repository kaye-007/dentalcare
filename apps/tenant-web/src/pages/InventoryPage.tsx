import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Archive,
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  PackageMinus,
  PackagePlus,
  ClipboardList,
  History,
  Layers,
  Package,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  ShoppingCart,
  Trash2,
  Truck,
  TriangleAlert,
  Users,
} from 'lucide-react';
import {
  ApiError,
  inventoryApi,
  type ExpiryState,
  type InventoryAlerts,
  type InventoryItem,
  type InventoryLot,
  type LotUsage,
  type MovementKind,
  type MovementPayload,
  type StockMovement,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Modal, MoreMenu, PageHeader, type MoreItem } from '../components/ui';
import { useIsPhone } from '../lib/useIsPhone';
import { formatQty } from '../lib/format';
import PatientPicker from '../components/PatientPicker';
import PartnersModal from '../components/PartnersModal';
import { ReorderSheet, SupplierPicker } from '../components/Suppliers';
import { dateLocale, t, type StringKey } from '../lib/strings';

/**
 * Stock.
 *
 * The page opens on what needs attention. Nobody comes here to browse a
 * catalogue — they come because something ran out, is about to, or is about
 * to expire. So low items sort to the top, they are marked in the row itself
 * rather than in a legend, and expiring or recalled lots sit in a bar above
 * the table where they read without it.
 *
 * Recording a movement asks the question a clinic would ask out loud — what
 * happened? — and derives the arithmetic from the answer. Nobody types a minus
 * sign; stock-engine.ts on the API explains why that is worth two fields.
 *
 * Lot-tracked items add one question per movement: which lot. A delivery
 * names it from the packaging; a usage can leave it to the API, which takes
 * the earliest expiry; a write-off or a count has to say. Usage can also name
 * the patient, which is what makes a recall answerable.
 */

const KINDS: readonly MovementKind[] = ['receipt', 'usage', 'adjustment', 'write_off'];

/** Movements that make stock vanish unused. Both have to say why. */
const REASON_REQUIRED: readonly MovementKind[] = ['write_off', 'adjustment'];

const kindLabelKey = (k: MovementKind) => `inv.kind.${k}` as StringKey;
const kindHelpKey = (k: MovementKind) => `inv.kind.${k}.help` as StringKey;

const qty = formatQty;

function when(iso: string): string {
  return new Date(iso).toLocaleString(dateLocale(), {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A calendar date from the API. Parsed as local midnight, so it never shifts a day. */
function day(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "Articaine 4% A123 · Composite A2 B7 …" — enough to recognise, not a list. */
function summarise(lots: readonly InventoryLot[]): string {
  return (
    lots
      .slice(0, 3)
      .map((l) => `${l.itemName} ${l.lotNumber}`)
      .join(' · ') + (lots.length > 3 ? ' …' : '')
  );
}

function ExpiryPill({ state, date }: { state: ExpiryState; date: string | null }) {
  if (!date || (state !== 'expiring' && state !== 'expired')) return null;
  return (
    <span className={`pill ${state === 'expired' ? 'pill--danger' : 'pill--warn'}`}>
      <CalendarClock size={11} aria-hidden />{' '}
      {t(state === 'expired' ? 'inv.badge.expired' : 'inv.badge.expiring', {
        date: day(date),
      })}
    </span>
  );
}

/** The alert bar is styled for a link; as a button it needs the browser's defaults undone. */
const BAR_BUTTON = {
  width: '100%',
  textAlign: 'left',
  font: 'inherit',
  cursor: 'pointer',
} as const;

type Tab = 'items' | 'movements';
type Filter = 'all' | 'low' | 'expiring' | 'archived';

/** In stock / Low stock / Out of stock — words, so colour is never the only signal. */
function StockPill({ item }: { item: InventoryItem }) {
  if (item.outOfStock)
    return (
      <span className="pill pill--danger">
        <TriangleAlert size={11} aria-hidden /> {t('inv.badge.out')}
      </span>
    );
  if (item.lowStock)
    return (
      <span className="pill pill--warn">
        <TriangleAlert size={11} aria-hidden /> {t('inv.badge.low')}
      </span>
    );
  return <span className="pill pill--done">{t('inv.badge.ok')}</span>;
}

export default function InventoryPage() {
  const { can } = useAuth();
  const canManage = can('inventory:manage');
  const canRecord = can('inventory:write');
  const phone = useIsPhone();

  const [tab, setTab] = useState<Tab>('items');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');

  const [items, setItems] = useState<InventoryItem[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [movements, setMovements] = useState<StockMovement[] | null>(null);
  const [alerts, setAlerts] = useState<InventoryAlerts | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState<{
    item: InventoryItem;
    kind: MovementKind;
  } | null>(null);
  const [historyFor, setHistoryFor] = useState<InventoryItem | null>(null);
  const [lotsFor, setLotsFor] = useState<InventoryItem | null>(null);
  const [supplierFor, setSupplierFor] = useState<InventoryItem | null>(null);
  const [reordering, setReordering] = useState(false);
  const [suppliers, setSuppliers] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await inventoryApi.list({
        q: q.trim() || undefined,
        status: filter === 'archived' ? 'archived' : 'active',
        category: category || undefined,
        low: filter === 'low',
        expiring: filter === 'expiring',
      });
      setItems(list);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('inv.error.generic'));
      setItems([]);
    }
    // Advisory, as on the dashboard: a failure hides the bars, nothing more.
    inventoryApi
      .alerts()
      .then(setAlerts)
      .catch(() => setAlerts(null));
  }, [q, filter, category]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    inventoryApi
      .categories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    if (tab !== 'movements') return;
    inventoryApi
      .recentMovements(150)
      .then(setMovements)
      .catch(() => setMovements([]));
  }, [tab]);

  // The shelf at a glance: what is out, what is low, what is fine.
  const glance = useMemo(() => {
    if (!items || filter !== 'all' || category) return '';
    const out = items.filter((i) => i.outOfStock).length;
    const low = items.filter((i) => i.lowStock && !i.outOfStock).length;
    const fine = items.length - out - low;
    return [
      out > 0 ? `${out} out of stock` : null,
      low > 0 ? `${low} low` : null,
      `${fine} in stock`,
    ]
      .filter(Boolean)
      .join(' · ');
  }, [items, filter, category]);

  async function setStatus(item: InventoryItem, status: 'active' | 'archived') {
    setError(null);
    setNotice(null);
    try {
      await inventoryApi.update(item.id, { status });
      setNotice(
        t(status === 'archived' ? 'inv.archived' : 'inv.restored', { name: item.name }),
      );
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('inv.error.generic'));
    }
  }

  const expiryText = alerts
    ? [
        alerts.expiringCount === 1
          ? t('inv.expiry.one')
          : alerts.expiringCount > 1
            ? t('inv.expiry.many', { count: alerts.expiringCount })
            : null,
        alerts.expiredCount > 0
          ? t('inv.expiry.expired', { count: alerts.expiredCount })
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <div className="page">
      <PageHeader
        title={t('inv.title')}
        meta={glance || t('inv.meta')}
        actions={
          <>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setSuppliers(true)}
            >
              <Truck size={14} aria-hidden /> Suppliers
            </button>
            {canManage && (
              <button
                className="btn btn--primary btn--sm"
                onClick={() => setCreating(true)}
              >
                <Plus size={14} aria-hidden /> {t('inv.add')}
              </button>
            )}
          </>
        }
      />

      {/* What needs ordering, and the one thing to do about it. */}
      {alerts && alerts.lowCount > 0 && (
        <div className="alertbar alertbar--low" role="status">
          <TriangleAlert size={16} aria-hidden />
          <span>
            {[
              alerts.outOfStockCount > 0
                ? `${alerts.outOfStockCount} out of stock`
                : null,
              `${alerts.lowCount - alerts.outOfStockCount} running low`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="alertbar__items">
            {alerts.items
              .slice(0, 4)
              .map((i) => i.name)
              .join(', ')}
          </span>
          {canRecord && (
            <button
              type="button"
              className="btn btn--ghost btn--sm alertbar__action"
              onClick={() => setReordering(true)}
            >
              <ShoppingCart size={14} aria-hidden /> Reorder
            </button>
          )}
        </div>
      )}

      {/* Recalled stock first: it is the one that must not reach a patient. */}
      {alerts && alerts.recalledLots.length > 0 && (
        <div className="alertbar" role="status">
          <ShieldAlert size={16} aria-hidden />
          <span>
            {t('inv.expiry.recalled', { items: summarise(alerts.recalledLots) })}
          </span>
        </div>
      )}

      {alerts && alerts.expiringLots.length > 0 && filter !== 'expiring' && (
        <button
          type="button"
          className="alertbar"
          style={BAR_BUTTON}
          onClick={() => {
            setTab('items');
            setFilter('expiring');
          }}
        >
          <CalendarClock size={16} aria-hidden />
          <span>{expiryText}</span>
          <span className="alertbar__items">{summarise(alerts.expiringLots)}</span>
          <span className="alertbar__go">{t('inv.filter.expiring')}</span>
        </button>
      )}

      {error && <p className="formerror">{error}</p>}
      {notice && (
        <p className="muted" style={{ fontSize: 13 }}>
          {notice}
        </p>
      )}

      <div className="toolbar">
        <div className="tabs">
          <button
            className={`tab${tab === 'items' ? ' tab--active' : ''}`}
            onClick={() => setTab('items')}
          >
            {t('inv.tab.items')}
          </button>
          <button
            className={`tab${tab === 'movements' ? ' tab--active' : ''}`}
            onClick={() => setTab('movements')}
          >
            {t('inv.tab.movements')}
          </button>
        </div>

        {tab === 'items' && (
          <div className="searchbox">
            <Search size={15} aria-hidden />
            <input
              type="search"
              value={q}
              placeholder={t('inv.search')}
              aria-label={t('inv.search')}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        )}
      </div>

      {tab === 'items' ? (
        <>
          <div className="toolbar toolbar--filters">
            <div className="tabs">
              {(['all', 'low', 'expiring', 'archived'] as const).map((f) => (
                <button
                  key={f}
                  className={`tab${filter === f ? ' tab--active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {t(`inv.filter.${f}` as StringKey)}
                </button>
              ))}
            </div>
            {categories.length > 0 && (
              <label className="field field--inline">
                <select
                  value={category}
                  aria-label={t('inv.filter.category')}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">{t('inv.filter.category')}</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="card">
            {items === null ? (
              <div className="pad muted">{t('common.loading')}</div>
            ) : items.length === 0 ? (
              filter === 'low' ? (
                <EmptyState
                  icon={<Package size={22} />}
                  title={t('inv.emptyLow.title')}
                  body={t('inv.emptyLow.body')}
                />
              ) : filter === 'expiring' ? (
                <EmptyState
                  icon={<CalendarClock size={22} />}
                  title={t('inv.emptyExpiring.title')}
                  body={t('inv.emptyExpiring.body')}
                />
              ) : filter === 'archived' ? (
                <EmptyState icon={<Archive size={22} />} title={t('inv.emptyArchived')} />
              ) : (
                <EmptyState
                  icon={<Package size={22} />}
                  title={t('inv.empty.title')}
                  body={t('inv.empty.body')}
                />
              )
            ) : (
              <StockList
                items={items}
                phone={phone}
                canRecord={canRecord}
                menu={(item) => [
                  ...(item.trackLots
                    ? [
                        {
                          label: t('inv.lots'),
                          icon: <Layers size={15} />,
                          onSelect: () => setLotsFor(item),
                        },
                      ]
                    : []),
                  {
                    label: t('inv.history'),
                    icon: <History size={15} />,
                    onSelect: () => setHistoryFor(item),
                  },
                  ...(canRecord && item.status === 'active'
                    ? [
                        {
                          label: item.supplierName
                            ? `Supplier: ${item.supplierName}`
                            : 'Set supplier…',
                          icon: <Truck size={15} />,
                          onSelect: () => setSupplierFor(item),
                        },
                        {
                          label: t('inv.count'),
                          icon: <ClipboardList size={15} />,
                          onSelect: () =>
                            setMoving({ item, kind: 'adjustment' as const }),
                        },
                      ]
                    : []),
                  ...(canManage
                    ? [
                        {
                          label: t('inv.action.edit'),
                          icon: <Pencil size={15} />,
                          onSelect: () => setEditing(item),
                        },
                        item.status === 'active'
                          ? {
                              label: t('inv.action.archive'),
                              icon: <Trash2 size={15} />,
                              danger: true,
                              onSelect: () => void setStatus(item, 'archived'),
                            }
                          : {
                              label: t('inv.action.restore'),
                              icon: <RotateCcw size={15} />,
                              onSelect: () => void setStatus(item, 'active'),
                            },
                      ]
                    : []),
                ]}
                onMove={(item, kind) => setMoving({ item, kind })}
              />
            )}
          </div>
        </>
      ) : (
        <div className="card">
          {movements === null ? (
            <div className="pad muted">{t('common.loading')}</div>
          ) : movements.length === 0 ? (
            <EmptyState icon={<History size={22} />} title={t('inv.movements.empty')} />
          ) : (
            <MovementTable rows={movements} showItem />
          )}
        </div>
      )}

      {(creating || editing) && (
        <ItemModal
          item={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            setNotice(t('inv.saved'));
            void load();
          }}
        />
      )}

      {moving && (
        <MovementModal
          item={moving.item}
          initialKind={moving.kind}
          onClose={() => setMoving(null)}
          onRecorded={(item) => {
            setMoving(null);
            setNotice(
              t('inv.recorded', {
                name: item.name,
                quantity: qty(item.quantity),
                unit: item.unit,
              }),
            );
            void load();
          }}
        />
      )}

      {historyFor && (
        <HistoryModal item={historyFor} onClose={() => setHistoryFor(null)} />
      )}

      {lotsFor && (
        <LotsModal
          item={lotsFor}
          onClose={() => setLotsFor(null)}
          onChanged={() => void load()}
        />
      )}

      {reordering && alerts && (
        <ReorderSheet
          items={alerts.items}
          onClose={() => setReordering(false)}
          onSetSupplier={(item) => {
            setReordering(false);
            setSupplierFor(item);
          }}
        />
      )}
      {supplierFor && (
        <SupplierPicker
          item={supplierFor}
          onClose={() => setSupplierFor(null)}
          onSaved={() => {
            setSupplierFor(null);
            void load();
          }}
        />
      )}
      {suppliers && (
        <PartnersModal
          kind="supplier"
          canWrite={canRecord}
          onClose={() => {
            setSuppliers(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

/* ── the stock list ──────────────────────────────────────────
   What is on the shelf and whether to order more: item, category, stock,
   minimum, status. The two things done to stock every day — it came in, it
   was used — are one tap on the row; everything else is under More. A phone
   gets one compact card per item instead of a table that scrolls sideways. */
function StockList({
  items,
  phone,
  canRecord,
  menu,
  onMove,
}: {
  items: InventoryItem[];
  phone: boolean;
  canRecord: boolean;
  menu: (item: InventoryItem) => MoreItem[];
  onMove: (item: InventoryItem, kind: MovementKind) => void;
}) {
  // One visible action per row — stock arriving is the one to do quickly;
  // taking stock out is first in the row's menu, with the rest.
  const canMove = (item: InventoryItem) => canRecord && item.status === 'active';
  const moves = (item: InventoryItem) =>
    canMove(item) ? (
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label={`${t('inv.stockIn')}: ${item.name}`}
        onClick={() => onMove(item, 'receipt')}
      >
        <PackagePlus size={14} aria-hidden /> {t('inv.stockIn')}
      </button>
    ) : null;
  const rowMenu = (item: InventoryItem): MoreItem[] => [
    ...(canMove(item) && !item.outOfStock
      ? [
          {
            label: t('inv.stockOut'),
            icon: <PackageMinus size={15} aria-hidden />,
            onSelect: () => onMove(item, 'usage'),
          },
        ]
      : []),
    ...menu(item),
  ];

  if (phone) {
    return (
      <ul className="stockcards">
        {items.map((item) => (
          <li
            key={item.id}
            className={`stockcard${item.outOfStock ? ' stockcard--out' : item.lowStock ? ' stockcard--low' : ''}`}
          >
            <div className="stockcard__head">
              <span className="stockcard__name">{item.name}</span>
              <MoreMenu items={rowMenu(item)} label={`More for ${item.name}`} />
            </div>
            <div className="stockcard__facts">
              <span className="stockcard__qty">
                <strong>{qty(item.quantity)}</strong> {item.unit}
              </span>
              <span className="muted">
                {t('inv.col.minimum')} {qty(item.minimumQuantity)}
                {item.category ? ` · ${item.category}` : ''}
              </span>
            </div>
            <div className="stockcard__foot">
              <span className="stockcard__pills">
                <StockPill item={item} />
                <ExpiryPill state={item.expiry} date={item.nextExpiry} />
              </span>
              <span className="stockcard__moves">{moves(item)}</span>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <table className="table stocktable">
      <thead>
        <tr>
          <th>{t('inv.col.item')}</th>
          <th className="hide-md">{t('inv.col.category')}</th>
          <th className="num">{t('inv.col.inStock')}</th>
          <th className="num hide-md">{t('inv.col.minimum')}</th>
          <th className="hide-md">{t('inv.col.status')}</th>
          <th>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr
            key={item.id}
            // The Status column says low or out; the row itself is only
            // marked for stock that has expired on the shelf.
            className={item.expiry === 'expired' ? 'row--warn' : undefined}
          >
            <td>
              <div className="stack-xs">
                <strong>{item.name}</strong>
                {/* Tablets: the minimum, category and stock state under the
                    name, as the phone card has them, so Add stock stays
                    inside the card. */}
                <span className="cell-sub show-md">
                  {t('inv.col.minimum')} {qty(item.minimumQuantity)}
                  {item.category ? ` · ${item.category}` : ''}
                </span>
                <span className="show-md">
                  <StockPill item={item} />
                </span>
                <ExpiryPill state={item.expiry} date={item.nextExpiry} />
              </div>
            </td>
            <td className="muted hide-md">{item.category ?? '—'}</td>
            <td className="num">
              <strong>{qty(item.quantity)}</strong>{' '}
              <span className="muted">{item.unit}</span>
            </td>
            <td className="num muted hide-md">{qty(item.minimumQuantity)}</td>
            <td className="hide-md">
              <StockPill item={item} />
            </td>
            <td>
              <div className="rowactions">
                {moves(item)}
                <MoreMenu items={rowMenu(item)} label={`More for ${item.name}`} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── movement table ──────────────────────────────────────── */

function MovementTable({
  rows,
  showItem = false,
}: {
  rows: StockMovement[];
  showItem?: boolean;
}) {
  // Only where they say something: a clinic that tracks no lots should not
  // look at a column of dashes.
  const showLot = rows.some((m) => m.lotNumber);
  const showPatient = rows.some((m) => m.patientName);

  return (
    <table className="table table--compact">
      <thead>
        <tr>
          <th>{t('inv.col.when')}</th>
          {showItem && <th>{t('inv.col.item')}</th>}
          <th>{t('inv.tab.movements')}</th>
          {showLot && <th>{t('inv.col.lot')}</th>}
          <th className="num">{t('inv.col.change')}</th>
          <th className="num">{t('inv.col.after')}</th>
          {showPatient && <th>{t('inv.col.patient')}</th>}
          <th>{t('inv.col.who')}</th>
          <th>{t('inv.col.reason')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id}>
            <td className="muted">{when(m.createdAt)}</td>
            {showItem && <td>{m.itemName}</td>}
            <td>{t(kindLabelKey(m.kind))}</td>
            {showLot && <td className="muted">{m.lotNumber ?? '—'}</td>}
            <td className={`num ${m.quantityDelta < 0 ? 'num--down' : 'num--up'}`}>
              {m.quantityDelta > 0 ? (
                <ArrowUpRight size={12} aria-hidden />
              ) : (
                <ArrowDownRight size={12} aria-hidden />
              )}
              {qty(Math.abs(m.quantityDelta))}
            </td>
            <td className="num">
              {qty(m.quantityAfter)} <span className="muted">{m.unit}</span>
            </td>
            {showPatient && <td>{m.patientName ?? '—'}</td>}
            <td className="muted">{m.actorName ?? '—'}</td>
            <td className="muted">{m.reason ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── item create / edit ──────────────────────────────────── */

function ItemModal({
  item,
  onClose,
  onSaved,
}: {
  item: InventoryItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [category, setCategory] = useState(item?.category ?? '');
  const [unit, setUnit] = useState(item?.unit ?? '');
  const [opening, setOpening] = useState('0');
  const [minimum, setMinimum] = useState(String(item?.minimumQuantity ?? 0));
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [trackLots, setTrackLots] = useState(item?.trackLots ?? false);
  const [warningDays, setWarningDays] = useState(String(item?.expiryWarningDays ?? 60));
  const [lotNumber, setLotNumber] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openingQty = Number(opening) || 0;
  const days = Math.max(0, Math.round(Number(warningDays) || 0));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (item) {
        await inventoryApi.update(item.id, {
          name: name.trim(),
          category: category.trim(),
          unit: unit.trim(),
          minimumQuantity: Number(minimum) || 0,
          notes: notes.trim(),
          ...(trackLots !== item.trackLots ? { trackLots } : {}),
          ...(trackLots ? { expiryWarningDays: days } : {}),
        });
      } else {
        const openingLot = trackLots && openingQty > 0;
        await inventoryApi.create({
          name: name.trim(),
          category: category.trim() || undefined,
          unit: unit.trim(),
          quantity: openingQty,
          minimumQuantity: Number(minimum) || 0,
          notes: notes.trim() || undefined,
          ...(trackLots ? { trackLots: true, expiryWarningDays: days } : {}),
          ...(openingLot
            ? { lotNumber: lotNumber.trim(), expiresOn: expiresOn || undefined }
            : {}),
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inv.error.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={item ? t('inv.action.edit') : t('inv.add')} onClose={onClose}>
      <form className="modal__body" onSubmit={submit}>
        <label className="field">
          <span>{t('inv.form.name')}</span>
          <input
            value={name}
            required
            minLength={2}
            maxLength={120}
            placeholder={t('inv.form.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="grid2">
          <label className="field">
            <span>{t('inv.form.category')}</span>
            <input
              value={category}
              maxLength={60}
              placeholder={t('inv.form.categoryPlaceholder')}
              onChange={(e) => setCategory(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t('inv.form.unit')}</span>
            <input
              value={unit}
              required
              maxLength={20}
              placeholder={t('inv.form.unitPlaceholder')}
              onChange={(e) => setUnit(e.target.value)}
            />
          </label>
        </div>

        <div className="grid2">
          {/*
            Opening stock is create-only. On an existing item the quantity
            moves through a movement, so the history stays a complete account
            of the shelf rather than a partial one.
          */}
          {!item && (
            <label className="field">
              <span>{t('inv.form.opening')}</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span>{t('inv.form.minimum')}</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={minimum}
              onChange={(e) => setMinimum(e.target.value)}
            />
          </label>
        </div>

        <label className="hours-row__closed" style={{ width: 'auto' }}>
          <input
            type="checkbox"
            checked={trackLots}
            onChange={(e) => setTrackLots(e.target.checked)}
          />
          <span>{t('inv.form.trackLots')}</span>
        </label>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
          {t('inv.form.trackLotsHelp')}
        </p>

        {trackLots && (
          <div className="grid2">
            {!item && openingQty > 0 && (
              <>
                <label className="field">
                  <span>{t('inv.form.lotNumber')}</span>
                  <input
                    value={lotNumber}
                    required
                    maxLength={60}
                    placeholder={t('inv.form.lotNumberPlaceholder')}
                    onChange={(e) => setLotNumber(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{t('inv.form.expiresOn')}</span>
                  <input
                    type="date"
                    value={expiresOn}
                    onChange={(e) => setExpiresOn(e.target.value)}
                  />
                </label>
              </>
            )}
            <label className="field">
              <span>{t('inv.form.expiryWarning')}</span>
              <input
                type="number"
                min={0}
                max={730}
                step={1}
                value={warningDays}
                onChange={(e) => setWarningDays(e.target.value)}
              />
            </label>
          </div>
        )}

        <label className="field">
          <span>{t('inv.form.notes')}</span>
          <textarea
            rows={2}
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        {error && <p className="formerror">{error}</p>}

        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {t('common.save')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/* ── record a movement ───────────────────────────────────── */

function lotLabel(l: InventoryLot): string {
  const parts = [l.lotNumber, `${qty(l.quantity)} ${l.unit}`];
  if (l.expiresOn) parts.push(day(l.expiresOn));
  if (l.status === 'recalled') parts.push(t('inv.badge.recalled'));
  else if (l.expiry === 'expired')
    parts.push(t('inv.badge.expired', { date: '' }).trim());
  return parts.join(' · ');
}

function MovementModal({
  item,
  initialKind = 'usage',
  onClose,
  onRecorded,
}: {
  item: InventoryItem;
  initialKind?: MovementKind;
  onClose: () => void;
  onRecorded: (item: InventoryItem) => void;
}) {
  const { can } = useAuth();
  const tracked = item.trackLots;

  const [kind, setKind] = useState<MovementKind>(initialKind);
  const [amount, setAmount] = useState('1');
  const [counted, setCounted] = useState(String(item.quantity));
  const [reason, setReason] = useState('');
  const [lots, setLots] = useState<InventoryLot[] | null>(tracked ? null : []);
  const [lotId, setLotId] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tracked) return;
    inventoryApi
      .lots(item.id)
      .then(setLots)
      .catch(() => setLots([]));
  }, [item.id, tracked]);

  const isCount = kind === 'adjustment';
  const reasonRequired = REASON_REQUIRED.includes(kind);

  // A count may find stock in a lot the system thinks is empty; everything
  // else only makes sense against a lot that holds some.
  const choosable = useMemo(
    () => (lots ?? []).filter((l) => kind === 'adjustment' || l.quantity > 0),
    [lots, kind],
  );
  const typed = lotNumber.trim().toLowerCase();
  const existingLot =
    kind === 'receipt' && typed
      ? ((lots ?? []).find((l) => l.lotNumber.trim().toLowerCase() === typed) ?? null)
      : null;

  function chooseKind(k: MovementKind) {
    setKind(k);
    setLotId('');
    setError(null);
    if (k === 'adjustment') setCounted(String(item.quantity));
  }

  function chooseLot(id: string) {
    setLotId(id);
    const lot = (lots ?? []).find((l) => l.id === id);
    if (lot && kind === 'adjustment') setCounted(String(lot.quantity));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const lotPart: Partial<MovementPayload> = !tracked
      ? {}
      : kind === 'receipt'
        ? {
            lotNumber: lotNumber.trim(),
            ...(!existingLot && expiresOn ? { expiresOn } : {}),
          }
        : lotId
          ? { lotId }
          : {};

    const payload: MovementPayload = isCount
      ? { kind, countedQuantity: Number(counted), reason: reason.trim(), ...lotPart }
      : {
          kind,
          amount: Number(amount),
          reason: reason.trim() || undefined,
          ...lotPart,
          ...(kind === 'usage' && patient ? { patientId: patient.id } : {}),
        };
    try {
      const res = await inventoryApi.recordMovement(item.id, payload);
      onRecorded(res.item);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inv.error.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('inv.record')}
      subtitle={t('inv.form.currentlyHave', {
        quantity: qty(item.quantity),
        unit: item.unit,
      })}
      onClose={onClose}
    >
      <form className="modal__body" onSubmit={submit}>
        {/*
          The kind is chosen before the number, because the kind is what
          decides whether the number goes up or down. Asking for a signed
          quantity instead is how a stock count gets entered backwards.
        */}
        <div className="choices">
          {KINDS.map((k) => (
            <button
              type="button"
              key={k}
              className={`choice${kind === k ? ' choice--active' : ''}`}
              aria-pressed={kind === k}
              onClick={() => chooseKind(k)}
            >
              <strong>{t(kindLabelKey(k))}</strong>
              <span className="muted">{t(kindHelpKey(k))}</span>
            </button>
          ))}
        </div>

        {tracked && kind === 'receipt' && (
          <div className="grid2">
            <label className="field">
              <span>{t('inv.form.lotNumber')}</span>
              <input
                value={lotNumber}
                required
                maxLength={60}
                list={`lots-${item.id}`}
                placeholder={t('inv.form.lotNumberPlaceholder')}
                onChange={(e) => setLotNumber(e.target.value)}
              />
              <datalist id={`lots-${item.id}`}>
                {(lots ?? [])
                  .filter((l) => l.status === 'active')
                  .map((l) => (
                    <option key={l.id} value={l.lotNumber} />
                  ))}
              </datalist>
            </label>
            {existingLot ? (
              // More of a lot already on record: its expiry date is already
              // known, and the API refuses a different one.
              <p
                className="muted"
                style={{ fontSize: 12.5, alignSelf: 'end', margin: 0 }}
              >
                {existingLot.expiresOn
                  ? t('inv.badge.expiring', { date: day(existingLot.expiresOn) })
                  : t('inv.lots.noExpiry')}
              </p>
            ) : (
              <label className="field">
                <span>{t('inv.form.expiresOn')}</span>
                <input
                  type="date"
                  value={expiresOn}
                  onChange={(e) => setExpiresOn(e.target.value)}
                />
              </label>
            )}
          </div>
        )}

        {tracked && kind !== 'receipt' && (
          <label className="field">
            <span>{t('inv.form.lot')}</span>
            <select
              value={lotId}
              required={kind !== 'usage'}
              onChange={(e) => chooseLot(e.target.value)}
            >
              <option value="" disabled={kind !== 'usage'}>
                {kind === 'usage' ? t('inv.form.lotAuto') : t('inv.form.lotChoose')}
              </option>
              {choosable.map((l) => (
                <option
                  key={l.id}
                  value={l.id}
                  disabled={
                    kind === 'usage' &&
                    (l.status === 'recalled' || l.expiry === 'expired')
                  }
                >
                  {lotLabel(l)}
                </option>
              ))}
            </select>
          </label>
        )}

        {isCount ? (
          <label className="field">
            <span>{t('inv.form.counted')}</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={counted}
              required
              onChange={(e) => setCounted(e.target.value)}
            />
          </label>
        ) : (
          <label className="field">
            <span>
              {t('inv.form.amount')} <span className="muted">({item.unit})</span>
            </span>
            <input
              type="number"
              min={0.01}
              step="0.01"
              value={amount}
              required
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
        )}

        {kind === 'usage' && can('patients:read') && (
          <div className="stack-xs">
            <span className="muted" style={{ fontSize: 12.5 }}>
              {t('inv.form.patient')}
            </span>
            <PatientPicker
              value={patient?.name ?? ''}
              onPick={(p) =>
                setPatient({ id: p.id, name: `${p.firstName} ${p.lastName}` })
              }
              onClear={() => setPatient(null)}
            />
          </div>
        )}

        <label className="field">
          <span>
            {reasonRequired ? t('inv.form.reasonRequired') : t('inv.form.reason')}
          </span>
          <input
            value={reason}
            required={reasonRequired}
            minLength={reasonRequired ? 3 : undefined}
            maxLength={300}
            placeholder={t('inv.form.reasonPlaceholder')}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        {error && <p className="formerror">{error}</p>}

        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {t('inv.record')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/* ── per-item history ────────────────────────────────────── */

function HistoryModal({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const [rows, setRows] = useState<StockMovement[] | null>(null);

  useEffect(() => {
    inventoryApi
      .movements(item.id, 200)
      .then(setRows)
      .catch(() => setRows([]));
  }, [item.id]);

  return (
    <Modal title={`${t('inv.history')} — ${item.name}`} onClose={onClose} wide>
      <div className="modal__body">
        {item.status === 'archived' && <p className="muted">{t('inv.archivedNote')}</p>}
        {rows === null ? (
          <div className="pad muted">{t('common.loading')}</div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<History size={22} />} title={t('inv.movements.empty')} />
        ) : (
          <MovementTable rows={rows} />
        )}
      </div>
    </Modal>
  );
}

/* ── lots, recalls and who received them ─────────────────── */

function LotsModal({
  item,
  onClose,
  onChanged,
}: {
  item: InventoryItem;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const canManage = can('inventory:manage');
  const canSeePatients = can('patients:read');

  const [lots, setLots] = useState<InventoryLot[] | null>(null);
  const [recalling, setRecalling] = useState<InventoryLot | null>(null);
  const [usageOf, setUsageOf] = useState<InventoryLot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    inventoryApi
      .lots(item.id)
      .then(setLots)
      .catch(() => setLots([]));
  }, [item.id]);

  useEffect(() => {
    load();
  }, [load]);

  if (usageOf) {
    return <LotUsageModal lot={usageOf} onClose={() => setUsageOf(null)} />;
  }
  if (recalling) {
    return (
      <RecallModal
        lot={recalling}
        onClose={() => setRecalling(null)}
        onRecalled={(patients) => {
          setNotice(
            t('inv.lots.recalled', { lot: recalling.lotNumber, count: patients }),
          );
          setRecalling(null);
          load();
          onChanged();
        }}
      />
    );
  }

  return (
    <Modal title={t('inv.lots.title', { name: item.name })} onClose={onClose} wide>
      <div className="modal__body">
        {notice && (
          <p className="muted" style={{ fontSize: 13 }}>
            {notice}
          </p>
        )}
        {lots === null ? (
          <div className="pad muted">{t('common.loading')}</div>
        ) : lots.length === 0 ? (
          <EmptyState icon={<Layers size={22} />} title={t('inv.lots.empty')} />
        ) : (
          <table className="table table--compact">
            <thead>
              <tr>
                <th>{t('inv.lots.col.lot')}</th>
                <th>{t('inv.lots.col.expires')}</th>
                <th>{t('inv.lots.col.received')}</th>
                <th className="num">{t('inv.lots.col.quantity')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lots.map((l) => (
                <tr
                  key={l.id}
                  className={
                    l.quantity > 0 && (l.status === 'recalled' || l.expiry === 'expired')
                      ? 'row--warn'
                      : undefined
                  }
                >
                  <td>
                    <div className="stack-xs">
                      <strong>{l.lotNumber}</strong>
                      {l.status === 'recalled' && (
                        <span
                          className="pill pill--danger"
                          title={l.recallReason ?? undefined}
                        >
                          <ShieldAlert size={11} aria-hidden /> {t('inv.badge.recalled')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    {!l.expiresOn ? (
                      <span className="muted">{t('inv.lots.noExpiry')}</span>
                    ) : l.quantity > 0 &&
                      (l.expiry === 'expiring' || l.expiry === 'expired') ? (
                      <ExpiryPill state={l.expiry} date={l.expiresOn} />
                    ) : (
                      day(l.expiresOn)
                    )}
                  </td>
                  <td className="muted">{day(l.receivedOn)}</td>
                  <td className="num">
                    <strong>{qty(l.quantity)}</strong>{' '}
                    <span className="muted">{l.unit}</span>
                  </td>
                  <td>
                    <div className="rowactions">
                      {canSeePatients && (
                        <button
                          className="iconbtn"
                          title={t('inv.lots.patients')}
                          aria-label={t('inv.lots.patients')}
                          onClick={() => setUsageOf(l)}
                        >
                          <Users size={14} aria-hidden />
                        </button>
                      )}
                      {canManage && l.status === 'active' && (
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => setRecalling(l)}
                        >
                          <ShieldAlert size={13} aria-hidden /> {t('inv.lots.recall')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

function RecallModal({
  lot,
  onClose,
  onRecalled,
}: {
  lot: InventoryLot;
  onClose: () => void;
  onRecalled: (patientsAffected: number) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await inventoryApi.recallLot(lot.id, reason.trim());
      onRecalled(res.patientsAffected);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inv.error.generic'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('inv.lots.recallTitle', { lot: lot.lotNumber })}
      subtitle={`${lot.itemName} · ${qty(lot.quantity)} ${lot.unit}`}
      onClose={onClose}
    >
      <form className="modal__body" onSubmit={submit}>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          {t('inv.lots.recallBody')}
        </p>
        <label className="field">
          <span>{t('inv.lots.recallReason')}</span>
          <input
            value={reason}
            required
            minLength={3}
            maxLength={300}
            placeholder={t('inv.lots.recallReasonPlaceholder')}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        {error && <p className="formerror">{error}</p>}

        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {t('inv.lots.recall')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function LotUsageModal({ lot, onClose }: { lot: InventoryLot; onClose: () => void }) {
  const [data, setData] = useState<LotUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inventoryApi
      .lotUsage(lot.id)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : t('inv.error.generic')));
  }, [lot.id]);

  const traced = data ? data.uses.filter((u) => u.patientId) : [];

  return (
    <Modal
      title={t('inv.lots.usageTitle', { lot: lot.lotNumber })}
      subtitle={lot.itemName}
      onClose={onClose}
      wide
    >
      <div className="modal__body">
        {error ? (
          <p className="formerror">{error}</p>
        ) : data === null ? (
          <div className="pad muted">{t('common.loading')}</div>
        ) : (
          <>
            {traced.length === 0 ? (
              <EmptyState icon={<Users size={22} />} title={t('inv.lots.usageEmpty')} />
            ) : (
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>{t('inv.col.when')}</th>
                    <th>{t('inv.lots.col.patient')}</th>
                    <th>{t('inv.lots.col.procedure')}</th>
                    <th className="num">{t('inv.col.change')}</th>
                    <th>{t('inv.col.who')}</th>
                  </tr>
                </thead>
                <tbody>
                  {traced.map((u) => (
                    <tr key={u.id}>
                      <td className="muted">{when(u.createdAt)}</td>
                      <td>
                        <strong>{u.patientName}</strong>
                      </td>
                      <td className="muted">
                        {u.procedureDescription
                          ? `${u.procedureDescription}${u.performedOn ? ` · ${day(u.performedOn)}` : ''}`
                          : '—'}
                      </td>
                      <td className="num">
                        {qty(u.quantity)} <span className="muted">{lot.unit}</span>
                      </td>
                      <td className="muted">{u.actorName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {/* The honest limit of a recall list: usage with no patient recorded. */}
            {data.unattributedQuantity > 0 && (
              <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
                <TriangleAlert size={13} aria-hidden />{' '}
                {t('inv.lots.unattributed', {
                  quantity: qty(data.unattributedQuantity),
                  unit: lot.unit,
                })}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
