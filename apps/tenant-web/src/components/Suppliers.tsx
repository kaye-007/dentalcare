import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, Phone } from 'lucide-react';
import { toE164 } from '@dentalcare/shared';
import {
  humanError,
  inventoryApi,
  settingsApi,
  suppliersApi,
  type InventoryItem,
  type Partner,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { telLink } from '../lib/lab';
import { LoadingRows, Modal, useToast } from './ui';

const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * Who an item is reordered from: one of the clinic's suppliers, or a new one
 * typed in here. Changes no warning, so the desk may set it.
 */
export function SupplierPicker({
  item,
  onClose,
  onSaved,
}: {
  item: InventoryItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [list, setList] = useState<Partner[] | null>(null);
  const [chosen, setChosen] = useState(item.supplierId ?? '');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    suppliersApi
      .list()
      .then(setList)
      .catch(() => setList([]));
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let supplierId: string | null = chosen || null;
      if (chosen === '__new') {
        const created = await suppliersApi.create({
          name: name.trim(),
          phone: phone.trim() || undefined,
        });
        supplierId = created.id;
      }
      const saved = await inventoryApi.setSupplier(item.id, supplierId);
      toast(
        saved.supplierName
          ? `${item.name} is reordered from ${saved.supplierName}.`
          : `${item.name} no longer names a supplier.`,
      );
      onSaved();
    } catch (err) {
      setError(humanError(err, 'The supplier could not be saved.'));
      setBusy(false);
    }
  }

  return (
    <Modal title="Supplier" subtitle={item.name} onClose={onClose}>
      <div className="modal__body">
        {list === null ? (
          <LoadingRows rows={2} label="Loading suppliers" />
        ) : (
          <label className="field">
            <span>Reordered from</span>
            <select value={chosen} onChange={(e) => setChosen(e.target.value)} autoFocus>
              <option value="">Nobody named</option>
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value="__new">A new supplier…</option>
            </select>
          </label>
        )}
        {chosen === '__new' && (
          <div className="grid2">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>Phone</span>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="068 123 4567"
              />
            </label>
          </div>
        )}
        {error && (
          <p className="formerror" role="alert">
            {error}
          </p>
        )}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || (chosen === '__new' && name.trim().length < 2)}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * "11 items low" turned into what to do about it: the low items grouped by who
 * they come from, each supplier one tap from a WhatsApp message listing them
 * (in Albanian, as the order is placed) or a call. Items with no supplier say
 * so, with the way to name one.
 */
export function ReorderSheet({
  items,
  onClose,
  onSetSupplier,
}: {
  items: InventoryItem[];
  onClose: () => void;
  onSetSupplier: (item: InventoryItem) => void;
}) {
  const { user } = useAuth();
  const [countryCode, setCountryCode] = useState('355');
  useEffect(() => {
    settingsApi
      .get()
      .then((s) => setCountryCode(s.phoneCountryCode || '355'))
      .catch(() => undefined);
  }, []);

  const groups = useMemo(() => {
    const by = new Map<
      string,
      { name: string | null; phone: string | null; items: InventoryItem[] }
    >();
    for (const i of items) {
      const key = i.supplierId ?? '';
      const g = by.get(key) ?? {
        name: i.supplierName,
        phone: i.supplierPhone,
        items: [],
      };
      g.items.push(i);
      by.set(key, g);
    }
    // Named suppliers first, alphabetically; the unnamed last.
    return [...by.entries()].sort(([a, x], [b, y]) =>
      !a ? 1 : !b ? -1 : (x.name ?? '').localeCompare(y.name ?? ''),
    );
  }, [items]);

  const whatsapp = (phone: string | null, list: InventoryItem[]) => {
    const to = toE164(phone, countryCode);
    if (!to) return null;
    const lines = list
      .map(
        (i) =>
          `- ${i.name} (kemi ${qty(i.quantity)} ${i.unit}, minimumi ${qty(i.minimumQuantity)})`,
      )
      .join('\n');
    const text = `Përshëndetje${user?.clinicName ? ` nga ${user.clinicName}` : ''}, do të donim të porosisnim:\n${lines}\nFaleminderit!`;
    return `https://wa.me/${to.slice(1)}?text=${encodeURIComponent(text)}`;
  };

  return (
    <Modal title="Reorder" subtitle="What is low, by who it comes from" onClose={onClose}>
      <div className="modal__body reorder">
        {groups.map(([key, g]) => {
          const wa = key ? whatsapp(g.phone, g.items) : null;
          const tel = key ? telLink(g.phone) : null;
          return (
            <section
              key={key || 'none'}
              className="reorder__group"
              aria-label={g.name ?? 'No supplier yet'}
            >
              <div className="reorder__head">
                <span className="reorder__name">{g.name ?? 'No supplier yet'}</span>
                {key && (
                  <span className="reorder__do">
                    {wa && (
                      <a
                        className="btn btn--primary btn--sm"
                        href={wa}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <MessageCircle size={14} aria-hidden /> WhatsApp
                      </a>
                    )}
                    {tel && (
                      <a className="btn btn--ghost btn--sm" href={tel}>
                        <Phone size={14} aria-hidden /> Call
                      </a>
                    )}
                    {!wa && !tel && <span className="formhint">No phone on file</span>}
                  </span>
                )}
              </div>
              <ul className="reorder__items">
                {g.items.map((i) => (
                  <li key={i.id}>
                    <span className="reorder__item">{i.name}</span>
                    <span
                      className={`reorder__qty${i.outOfStock ? ' reorder__qty--out' : ''}`}
                    >
                      {i.outOfStock ? 'Out' : `${qty(i.quantity)} ${i.unit}`} · min{' '}
                      {qty(i.minimumQuantity)}
                    </span>
                    {!key && (
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => onSetSupplier(i)}
                      >
                        Set supplier
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
