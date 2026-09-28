import { useEffect, useState, type FormEvent } from 'react';
import { labsApi, suppliersApi, humanError, type Partner } from '../lib/api';
import { telLink } from '../lib/lab';
import { EmptyState, LoadingRows, Modal, useToast } from './ui';
import { Building2 } from 'lucide-react';

/**
 * The clinic's labs, or its suppliers: a name and a number each. Added in one
 * line, edited in place, retired rather than deleted (their past work still
 * names them).
 */
export default function PartnersModal({
  kind,
  canWrite,
  onClose,
}: {
  kind: 'lab' | 'supplier';
  canWrite: boolean;
  onClose: () => void;
}) {
  const api = kind === 'lab' ? labsApi : suppliersApi;
  const noun = kind === 'lab' ? 'lab' : 'supplier';
  const toast = useToast();
  const [list, setList] = useState<Partner[] | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', phone: '' });
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .list(true)
      .then(setList)
      .catch((err) => setError(humanError(err)));
  useEffect(() => {
    void load();
    // `api` is chosen by `kind`, which does not change while the modal is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setError(null);
    try {
      await api.create({ name: name.trim(), phone: phone.trim() || undefined });
      toast(`Added ${name.trim()}.`);
      setName('');
      setPhone('');
      await load();
    } catch (err) {
      setError(humanError(err, `The ${noun} could not be added.`));
    }
  }

  async function save(p: Partner) {
    setError(null);
    try {
      await api.update(p.id, { name: draft.name.trim(), phone: draft.phone.trim() });
      setEditing(null);
      await load();
    } catch (err) {
      setError(humanError(err, 'That could not be saved.'));
    }
  }

  async function retire(p: Partner, isActive: boolean) {
    try {
      await api.update(p.id, { isActive });
      toast(isActive ? `${p.name} is back on the list.` : `${p.name} is retired.`, {
        action: {
          label: 'Undo',
          run: async () => {
            await api.update(p.id, { isActive: !isActive }).catch(() => undefined);
            await load();
          },
        },
      });
      await load();
    } catch (err) {
      setError(humanError(err, 'That could not be saved.'));
    }
  }

  return (
    <Modal
      title={kind === 'lab' ? 'Labs' : 'Suppliers'}
      subtitle={
        kind === 'lab'
          ? 'The dental laboratories the clinic sends work to.'
          : 'Who the clinic buys materials from.'
      }
      onClose={onClose}
    >
      <div className="modal__body partners">
        {list === null ? (
          <LoadingRows rows={3} label={`Loading ${noun}s`} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Building2 size={20} />}
            title={`No ${noun}s yet`}
            body={canWrite ? `Add the first one below.` : undefined}
          />
        ) : (
          <ul className="partners__list">
            {list.map((p) =>
              editing === p.id ? (
                <li key={p.id} className="partners__row partners__row--edit">
                  <input
                    aria-label="Name"
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                  <input
                    aria-label="Phone"
                    type="tel"
                    value={draft.phone}
                    onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => void save(p)}
                  >
                    Save
                  </button>
                </li>
              ) : (
                <li
                  key={p.id}
                  className={`partners__row${p.isActive ? '' : ' partners__row--retired'}`}
                >
                  <span className="partners__name">
                    {p.name}
                    {!p.isActive && <span className="partners__tag">Retired</span>}
                  </span>
                  {p.phone ? (
                    <a className="partners__phone" href={telLink(p.phone) ?? undefined}>
                      {p.phone}
                    </a>
                  ) : (
                    <span className="partners__phone muted">No phone</span>
                  )}
                  {canWrite && (
                    <span className="partners__do">
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => {
                          setEditing(p.id);
                          setDraft({ name: p.name, phone: p.phone ?? '' });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => void retire(p, !p.isActive)}
                      >
                        {p.isActive ? 'Retire' : 'Restore'}
                      </button>
                    </span>
                  )}
                </li>
              ),
            )}
          </ul>
        )}

        {canWrite && (
          <form className="partners__add" onSubmit={add}>
            <input
              aria-label={`New ${noun} name`}
              placeholder={kind === 'lab' ? 'Lab name' : 'Supplier name'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              aria-label="Phone"
              type="tel"
              placeholder="Phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn--ghost btn--sm"
              disabled={name.trim().length < 2}
            >
              Add
            </button>
          </form>
        )}
        {error && (
          <p className="formerror" role="alert">
            {error}
          </p>
        )}
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
