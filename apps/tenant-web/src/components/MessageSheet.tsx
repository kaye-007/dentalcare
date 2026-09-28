import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, Phone } from 'lucide-react';
import {
  defaultMessageTemplate,
  renderMessage,
  type MessagePurpose,
} from '@dentalcare/shared';
import { humanError, messagesApi, type MessageThread } from '../lib/api';
import { telLink } from '../lib/lab';
import { LoadingRows, Modal, Segmented, useToast } from './ui';

const PURPOSE_LABEL: Record<MessagePurpose, string> = {
  appointment_reminder: 'Reminder',
  post_procedure_followup: 'Follow-up',
  unpaid_balance: 'Balance',
  recall_invitation: 'Check-up',
};

/**
 * A message to a patient, from wherever the desk is: the record, a visit, an
 * invoice. It is one of the clinic's own written messages — a reminder of a
 * visit, a follow-up after one, a note about what is owed — shown exactly as
 * it will read, and sent from the desk's own WhatsApp. DentalCare fills it
 * in and keeps a record of it in the patient's message history; the person
 * presses send in WhatsApp.
 *
 * None of the wording names a treatment or a diagnosis: a message is read on
 * a lock screen, by whoever holds the phone.
 */
export default function MessageSheet({
  patientId,
  patientName,
  purpose: wanted,
  appointmentId: wantedAppointment,
  invoiceId,
  onClose,
}: {
  patientId: string;
  patientName: string;
  purpose?: MessagePurpose;
  appointmentId?: string;
  invoiceId?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [thread, setThread] = useState<MessageThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<MessagePurpose | null>(wanted ?? null);
  const [appointmentId, setAppointmentId] = useState(wantedAppointment ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    messagesApi
      .thread(patientId)
      .then((t) => {
        setThread(t);
        setAppointmentId((cur) => cur || t.context.upcoming[0]?.id || '');
      })
      .catch((err) =>
        setError(humanError(err, 'The patient’s messages could not be loaded.')),
      );
  }, [patientId]);

  // What there is to say to this patient right now.
  const offered = useMemo<MessagePurpose[]>(() => {
    if (!thread) return [];
    return [
      ...(thread.context.upcoming.length ? (['appointment_reminder'] as const) : []),
      ...(thread.context.latestVisit ? (['post_procedure_followup'] as const) : []),
      ...(thread.context.balance > 0 ? (['unpaid_balance'] as const) : []),
      // Been before, nothing booked: invite them back.
      ...(thread.context.latestVisit && !thread.context.upcoming.length
        ? (['recall_invitation'] as const)
        : []),
    ];
  }, [thread]);
  useEffect(() => {
    if (thread && (!purpose || !offered.includes(purpose)))
      setPurpose(offered[0] ?? null);
  }, [thread, offered, purpose]);

  const preview = useMemo(() => {
    if (!thread || !purpose) return '';
    const c = thread.clinic;
    const base = {
      first_name: thread.patient.firstName,
      clinic: c.name,
      clinic_phone: c.phone ?? '',
    };
    let values: Record<string, string> = base;
    if (purpose === 'appointment_reminder') {
      const a = thread.context.upcoming.find((x) => x.id === appointmentId);
      values = {
        ...base,
        date: a?.date ?? '',
        time: a?.time ?? '',
        dentist: a?.dentist ?? '',
        clinic_address: c.address ?? '',
      };
    } else if (purpose === 'post_procedure_followup' || purpose === 'recall_invitation') {
      // Both are written from the last visit; each fills only its own words.
      values = {
        ...base,
        visit_date: thread.context.latestVisit?.visitDate ?? '',
        dentist: thread.context.latestVisit?.dentist ?? '',
      };
    } else {
      const inv = invoiceId
        ? thread.context.invoices.find((i) => i.id === invoiceId)
        : null;
      values = { ...base, balance: inv?.balanceText ?? thread.context.balanceText };
    }
    const template =
      purpose === 'appointment_reminder' && c.reminderTemplate
        ? c.reminderTemplate
        : defaultMessageTemplate(purpose, c.locale, Boolean(c.phone));
    return renderMessage(template, purpose, values);
  }, [thread, purpose, appointmentId, invoiceId]);

  async function send() {
    if (!thread || !purpose) return;
    // Opened now, while this is still the tap that asked for it; a window
    // opened after the network call would be taken for a pop-up and blocked.
    const tab = window.open('', '_blank');
    setBusy(true);
    try {
      const out = await messagesApi.send(patientId, {
        purpose,
        channel: 'whatsapp',
        appointmentId: purpose === 'appointment_reminder' ? appointmentId : undefined,
        invoiceId: purpose === 'unpaid_balance' ? invoiceId : undefined,
      });
      if (out.handoffUrl) {
        if (tab) tab.location.href = out.handoffUrl;
        else window.location.href = out.handoffUrl;
      } else tab?.close();
      toast(`WhatsApp is open with the message for ${thread.patient.firstName}.`);
      onClose();
    } catch (err) {
      tab?.close();
      setError(humanError(err, 'The message could not be prepared. Try again.'));
      setBusy(false);
    }
  }

  const tel = telLink(thread?.patient.phone ?? null);
  const blocked = thread
    ? thread.patient.optedOut
      ? `${thread.patient.firstName} has asked not to receive messages.`
      : !thread.patient.e164
        ? 'There is no mobile number on file to message.'
        : offered.length === 0
          ? 'Nothing to send right now: no visit booked, no recent visit, nothing owed.'
          : null
    : null;

  return (
    <Modal
      title={`Message ${patientName}`}
      subtitle={thread?.patient.e164 ?? undefined}
      onClose={onClose}
    >
      <div className="modal__body msgsheet">
        {!thread && !error ? (
          <LoadingRows rows={2} label="Loading" />
        ) : blocked ? (
          <p className="formwarn" role="status">
            <span>{blocked}</span>
          </p>
        ) : thread && purpose ? (
          <>
            {offered.length > 1 && (
              <Segmented
                label="What the message is about"
                value={purpose}
                onChange={setPurpose}
                options={offered.map((p) => ({ value: p, label: PURPOSE_LABEL[p] }))}
              />
            )}
            {purpose === 'appointment_reminder' && thread.context.upcoming.length > 1 && (
              <label className="field">
                <span>Which visit</span>
                <select
                  value={appointmentId}
                  onChange={(e) => setAppointmentId(e.target.value)}
                >
                  {thread.context.upcoming.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.date}, {a.time}
                      {a.dentist ? ` · ${a.dentist}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <blockquote className="msgsheet__preview" aria-label="The message">
              {preview}
            </blockquote>
            <p className="formhint">
              Sent from your WhatsApp; you can change the words there before sending. It
              is kept in {thread.patient.firstName}’s message history.
            </p>
          </>
        ) : null}
        {error && (
          <p className="formerror" role="alert">
            {error}
          </p>
        )}
        <div className="modal__foot">
          {tel && (
            <a className="btn btn--ghost" href={tel}>
              <Phone size={15} aria-hidden /> Call
            </a>
          )}
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Close
            </button>
            {!blocked && thread && purpose && (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => void send()}
              >
                <MessageCircle size={15} aria-hidden />{' '}
                {busy ? 'Opening…' : 'Send on WhatsApp'}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
