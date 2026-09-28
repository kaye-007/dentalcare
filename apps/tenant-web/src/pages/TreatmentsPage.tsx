import { useEffect, useState, type FormEvent } from 'react';
import { Plus, Search, Stethoscope, Pencil } from 'lucide-react';
import {
  treatmentsApi,
  ApiError,
  type Treatment,
  type TreatmentPayload,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader, StatusPill, EmptyState, Modal, LoadingRows } from '../components/ui';
import { currencySymbol, formatMoney } from '../lib/format';
import MoneyInput from '../components/MoneyInput';
import { VAT_CATEGORIES, vatCategoryLabel, type VatCategory } from '@dentalcare/shared';
import { useClinicVatRate } from '../lib/vat';
import { useIsPhone } from '../lib/useIsPhone';

const TABS = [
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
  { key: 'all', label: 'All' },
] as const;

/**
 * What sets a service apart from the usual — several visits, TVSH, inactive —
 * for the tablet row, where those columns do not fit. Empty for most.
 */
function serviceNotes(t: Treatment, vatRate: number | null, showStatus: boolean): string {
  return [
    t.visitType === 'multiple' && 'Several visits',
    t.vatCategory === 'cosmetic' && `Cosmetic${vatRate ? ` · ${vatRate / 100}%` : ''}`,
    showStatus && t.status !== 'active' && 'Inactive',
  ]
    .filter(Boolean)
    .join(' · ');
}

export default function TreatmentsPage() {
  const { can } = useAuth();
  const canAccess = can('treatments:manage');

  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState<Treatment[] | null>(null);
  const [editing, setEditing] = useState<Treatment | null>(null);
  const [creating, setCreating] = useState(false);
  const vatRate = useClinicVatRate();
  const phone = useIsPhone();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  async function load() {
    setItems(await treatmentsApi.list({ q: debouncedQ, status }));
  }
  useEffect(() => {
    setItems(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, debouncedQ]);

  return (
    <div className="page">
      <PageHeader
        title="Services & prices"
        meta={items ? `${items.length} on the price list` : '…'}
        actions={
          canAccess ? (
            <button className="btn btn--primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> Add service
            </button>
          ) : undefined
        }
      />

      <section className="card">
        <div className="card__toolbar">
          <div className="tabs" role="group" aria-label="Filter services by status">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`tab${status === t.key ? ' tab--active' : ''}`}
                aria-pressed={status === t.key}
                onClick={() => setStatus(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <label className="searchbox">
            <Search size={16} aria-hidden />
            <span className="sr-only">Search services</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search services…"
            />
          </label>
        </div>
        {items === null ? (
          <LoadingRows rows={3} label="Loading" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Stethoscope size={22} />}
            title="No services found"
            body={
              canAccess
                ? 'Add your first service to build the price list.'
                : 'An administrator manages the price list.'
            }
          />
        ) : phone ? (
          // A phone reads the price list as a list: what it is, how long,
          // what it costs. Tapping a service opens it for editing.
          <ul className="svclist">
            {items.map((t) => {
              const body = (
                <>
                  <span className="svclist__main">
                    <span className="svclist__name">{t.name}</span>
                    <span className="svclist__meta">
                      {t.durationMinutes} min
                      {t.visitType === 'multiple' ? ' · several visits' : ''}
                      {t.vatCategory === 'cosmetic' ? ' · TVSH' : ''}
                      {t.status !== 'active' ? ' · inactive' : ''}
                    </span>
                  </span>
                  <span className="svclist__price">{formatMoney(t.price)}</span>
                </>
              );
              return (
                <li key={t.id}>
                  {canAccess ? (
                    <button
                      type="button"
                      className="svclist__row"
                      onClick={() => setEditing(t)}
                      aria-label={`Edit ${t.name}`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="svclist__row">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <table className="table svctable">
            <thead>
              <tr>
                <th>Service</th>
                <th className="num">Price</th>
                <th>Duration</th>
                <th className="hide-md">Visits</th>
                <th className="hide-md">TVSH</th>
                {status === 'all' && <th className="hide-md">Status</th>}
                {canAccess && (
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span style={{ fontWeight: 600 }}>{t.name}</span>
                    {/* Tablets: Visits, TVSH and Status fold under the name. */}
                    {serviceNotes(t, vatRate, status === 'all') && (
                      <span className="cell-sub show-md">
                        {serviceNotes(t, vatRate, status === 'all')}
                      </span>
                    )}
                  </td>
                  <td className="num nowrap">
                    <strong>{formatMoney(t.price)}</strong>
                  </td>
                  <td className="muted nowrap">{t.durationMinutes} min</td>
                  <td className="muted hide-md">
                    {t.visitType === 'multiple'
                      ? 'Several'
                      : t.visitType === 'single'
                        ? 'One'
                        : '—'}
                  </td>
                  <td className="hide-md">
                    {/* Exempt is the rule for dental work; only the exception
                        — cosmetic work that carries TVSH — is marked. */}
                    {t.vatCategory === 'cosmetic' ? (
                      <StatusPill
                        status="warn"
                        label={`Cosmetic${vatRate ? ` · ${vatRate / 100}%` : ''}`}
                      />
                    ) : (
                      <span className="muted">Exempt</span>
                    )}
                  </td>
                  {status === 'all' && (
                    <td className="hide-md">
                      <StatusPill status={t.status} />
                    </td>
                  )}
                  {canAccess && (
                    <td>
                      <div className="rowactions">
                        <button
                          type="button"
                          className="iconbtn"
                          onClick={() => setEditing(t)}
                          title="Edit"
                          aria-label={`Edit ${t.name}`}
                        >
                          <Pencil size={14} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {(creating || editing) && (
        <TreatmentModal
          treatment={editing ?? undefined}
          vatRate={vatRate ?? 0}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function TreatmentModal({
  treatment,
  vatRate,
  onClose,
  onSaved,
}: {
  treatment?: Treatment;
  vatRate: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(treatment);
  const [form, setForm] = useState<TreatmentPayload>({
    name: treatment?.name ?? '',
    price: treatment?.price ?? 0,
    durationMinutes: treatment?.durationMinutes ?? 60,
    visitType: treatment?.visitType ?? null,
    status: treatment?.status ?? 'active',
    vatCategory: treatment?.vatCategory ?? 'medical',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (editing) await treatmentsApi.update(treatment!.id, form);
      else await treatmentsApi.create(form);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save treatment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? 'Edit service' : 'New service'} onClose={onClose}>
      <form className="modal__body" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Tooth Filling"
            required
          />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Price ({currencySymbol()})</span>
            <MoneyInput
              value={form.price}
              placeholder="0.00"
              onChange={(v) => setForm((f) => ({ ...f, price: v ?? 0 }))}
            />
          </label>
          <label className="field">
            <span>Duration (minutes)</span>
            <input
              type="number"
              min={5}
              max={600}
              step={5}
              value={form.durationMinutes}
              onChange={(e) =>
                setForm((f) => ({ ...f, durationMinutes: Number(e.target.value) }))
              }
              required
            />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>
              Visit type{' '}
              <span className="muted" style={{ fontWeight: 400 }}>
                (optional)
              </span>
            </span>
            <select
              value={form.visitType ?? ''}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  visitType:
                    e.target.value === ''
                      ? null
                      : (e.target.value as 'single' | 'multiple'),
                }))
              }
            >
              <option value="">Not specified</option>
              <option value="single">Single visit</option>
              <option value="multiple">Multiple visits</option>
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select
              value={form.status}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  status: e.target.value as 'active' | 'inactive',
                }))
              }
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>TVSH category</span>
          <select
            value={form.vatCategory}
            onChange={(e) =>
              setForm((f) => ({ ...f, vatCategory: e.target.value as VatCategory }))
            }
          >
            {VAT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {vatCategoryLabel(c, vatRate)}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Medical treatment is exempt from TVSH. Work done for appearance only —
            whitening, cosmetic veneers — carries the standard rate. Confirm the category
            with the clinic's accountant.
          </span>
        </label>
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add service'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
