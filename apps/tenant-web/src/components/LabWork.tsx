import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Pencil, Phone, XCircle } from 'lucide-react';
import { humanError, labApi, type LabOrder, type LabStatus } from '../lib/api';
import {
  LAB_STATUS_LABEL,
  PREVIOUS,
  labWhatsApp,
  labWhen,
  nextLabStep,
  telLink,
  workLabel,
} from '../lib/lab';
import { Modal, MoreMenu, useToast, type MoreItem } from './ui';

/** Where a step back leaves the work, for the line that confirms an Undo. */
const AGAIN: Record<LabStatus, string> = {
  preparing: 'is being prepared again',
  sent: 'is at the lab again',
  received: 'is back from the lab, waiting to be fitted',
  fitted: 'is fitted again',
  cancelled: 'is cancelled again',
};

/**
 * Move lab work along, and say so with Undo. The step back is always one
 * step (the API allows exactly that; a Fitted only for its first minutes),
 * and a cancelled job is reinstated to where it was. An Undo says what it
 * put back, as a moved appointment or an undone check-in does.
 */
export function useLabMove(onChanged: () => void) {
  const toast = useToast();
  return useCallback(
    async (o: LabOrder, to: LabStatus, reason?: string) => {
      const from = o.status;
      try {
        await labApi.move(o.id, to, reason);
      } catch (err) {
        toast(humanError(err, 'The lab work could not be updated. Try again.'), 'error');
        return;
      }
      const words =
        to === 'cancelled'
          ? 'is cancelled'
          : (nextLabStep(from)?.said ?? LAB_STATUS_LABEL[to]);
      const back = to === 'cancelled' ? from : PREVIOUS[to] === from ? from : null;
      toast(`${o.work} for ${o.patientName} ${words}.`, {
        action: back
          ? {
              label: 'Undo',
              run: async () => {
                try {
                  await labApi.move(o.id, back);
                  toast(
                    to === 'cancelled'
                      ? `${o.work} for ${o.patientName} is no longer cancelled.`
                      : `${o.work} for ${o.patientName} ${AGAIN[back]}.`,
                  );
                } catch (err) {
                  toast(humanError(err, 'That could not be undone.'), 'error');
                }
                onChanged();
              },
            }
          : undefined,
      });
      onChanged();
    },
    [toast, onChanged],
  );
}

/** Cancelling lab work asks why; the reason stays on it. */
export function LabCancel({
  order,
  onClose,
  onCancel,
}: {
  order: LabOrder;
  onClose: () => void;
  onCancel: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={`Cancel ${order.work}?`} subtitle={order.patientName} onClose={onClose}>
      <form
        className="modal__body"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) onCancel(reason.trim());
        }}
      >
        <label className="field">
          <span>Why is it cancelled? (required)</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Patient postponed, remake ordered…"
            autoFocus
          />
        </label>
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Keep it
            </button>
            <button type="submit" className="btn btn--danger" disabled={!reason.trim()}>
              Cancel lab work
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** "At Dental Lab Tirana", "Back from Dental Lab Tirana", "Preparing". */
function where(o: LabOrder) {
  if (!o.labName) return LAB_STATUS_LABEL[o.status];
  if (o.status === 'sent') return `At ${o.labName}`;
  if (o.status === 'received') return `Back from ${o.labName}`;
  return `${LAB_STATUS_LABEL[o.status]} · ${o.labName}`;
}

/**
 * One piece of lab work as a row: what and which teeth, whose, where it is and
 * what its date means — then its one next step, and everything else behind ⋯
 * (call or message the lab, edit, cancel).
 */
export function LabWorkRow({
  order: o,
  canWrite,
  showPatient = true,
  countryCode,
  onMove,
  onEdit,
  onCancel,
}: {
  order: LabOrder;
  canWrite: boolean;
  showPatient?: boolean;
  countryCode?: string;
  onMove: (o: LabOrder, to: LabStatus) => void;
  onEdit: (o: LabOrder) => void;
  onCancel: (o: LabOrder) => void;
}) {
  const when = labWhen(o);
  const step = canWrite ? nextLabStep(o.status) : null;
  const tel = telLink(o.labPhone);
  const wa = labWhatsApp(o, countryCode);
  const more: MoreItem[] = [
    ...(tel
      ? [
          {
            label: `Call ${o.labName}`,
            icon: <Phone size={15} aria-hidden />,
            onSelect: () => (window.location.href = tel),
          },
        ]
      : []),
    ...(wa
      ? [
          {
            label: `WhatsApp ${o.labName}`,
            icon: <MessageCircle size={15} aria-hidden />,
            onSelect: () => window.open(wa, '_blank', 'noopener'),
          },
        ]
      : []),
    ...(canWrite && o.status !== 'fitted'
      ? [
          {
            label: 'Edit',
            icon: <Pencil size={15} aria-hidden />,
            onSelect: () => onEdit(o),
          },
        ]
      : []),
    ...(canWrite && o.status === 'cancelled'
      ? [
          {
            label: 'Reinstate',
            onSelect: () =>
              onMove(o, o.receivedAt ? 'received' : o.sentAt ? 'sent' : 'preparing'),
          },
        ]
      : []),
    ...(canWrite && ['preparing', 'sent', 'received'].includes(o.status)
      ? [
          {
            label: 'Cancel lab work…',
            icon: <XCircle size={15} aria-hidden />,
            danger: true,
            onSelect: () => onCancel(o),
          },
        ]
      : []),
  ];
  return (
    <li className={`labrow labrow--${o.status}${o.overdue ? ' labrow--late' : ''}`}>
      <div className="labrow__main">
        <span className="labrow__work">{workLabel(o)}</span>
        <span className="labrow__sub">
          {showPatient && (
            <>
              <Link to={`/patients/${o.patientId}`} className="labrow__patient">
                {o.patientName}
              </Link>
              {' · '}
            </>
          )}
          {[where(o), o.dentistName].filter(Boolean).join(' · ')}
        </span>
      </div>
      <span className={`labrow__when labrow__when--${when.tone}`}>{when.text}</span>
      <span className="labrow__do">
        {step && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label={`Mark ${o.work} for ${o.patientName} as ${LAB_STATUS_LABEL[step.to].toLowerCase()}`}
            onClick={() => onMove(o, step.to)}
          >
            {step.button}
          </button>
        )}
        <MoreMenu label={`More for ${o.work}, ${o.patientName}`} items={more} />
      </span>
    </li>
  );
}
