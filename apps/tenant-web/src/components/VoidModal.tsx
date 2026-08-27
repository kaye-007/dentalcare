import { FormEvent, useState } from 'react';
import { Modal } from './ui';
import { ApiError } from '../lib/api';
import { dateLocale } from '../lib/i18n';

/**
 * The reason prompt shared by every void.
 *
 * It says plainly that nothing is being deleted. Staff reach for "delete"
 * expecting the row to go away, and a control that quietly does something else
 * is how people end up voiding three times looking for the one that works.
 */
export default function VoidModal({
  title,
  subtitle,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  subtitle: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = reason.trim();
  // Matches the API's MinLength(3): a reason of "x" is not a reason.
  const valid = trimmed.length >= 3;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setError(null);
    setBusy(true);
    try {
      await onConfirm(trimmed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not void this entry.');
      setBusy(false);
    }
  }

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <form className="modal__body" onSubmit={submit}>
        <p className="voidnote">
          This does not delete anything. The entry stays on the record with your
          name, the time, and the reason you give here.
        </p>
        <label className="field">
          <span>Reason</span>
          <textarea
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
            placeholder="Wrong patient, wrong amount, patient cancelled…"
            rows={3}
            maxLength={300}
            autoFocus
            required
          />
        </label>
        {!valid && trimmed.length > 0 && (
          <p className="formhint">A few words, please — this is what the record will show.</p>
        )}
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--danger" disabled={busy || !valid}>
              {busy ? 'Voiding…' : confirmLabel}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** The trailing note shown on a row that has been voided. */
export function VoidedNote({
  at,
  by,
  reason,
}: {
  at: string;
  by: string | null;
  reason: string | null;
}) {
  const when = new Date(at).toLocaleString(dateLocale(), {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return (
    <span className="voidtag">
      Voided {when}
      {by ? ` by ${by}` : ''}
      {reason ? ` — ${reason}` : ''}
    </span>
  );
}
