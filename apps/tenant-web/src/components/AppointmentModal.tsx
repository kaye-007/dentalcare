import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  BellRing, MessageCircle, Mail, History, DoorOpen, Clock,
} from 'lucide-react';
import {
  ApiError,
  appointmentsApi,
  operatoriesApi,
  remindersApi,
  type Appointment,
  type ApptStatus,
  type Operatory,
  type Reminder,
  type StaffMember,
  type StatusEvent,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { Modal, StatusPill } from './ui';
import PatientPicker from './PatientPicker';
import { dateLocale } from '../lib/i18n';
import { useT } from '../lib/i18n';

const DURATIONS = [15, 20, 30, 45, 60, 90, 120];

function toLocalISO(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
}
function fmtDateTime(s: string) {
  return new Date(s).toLocaleString(dateLocale(), {
    weekday: 'short', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Reduce a phone number to the digits wa.me expects: no spaces, no punctuation,
 * no leading zeros or plus. Returns null when there is nothing usable, so the
 * button can be hidden rather than opening a broken link.
 */
export function whatsappNumber(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '').replace(/^0+/, '');
  return digits.length >= 8 ? digits : null;
}

/** The message staff hand to the patient. Kept short — it is typed into chat. */
export function composeReminder(a: Appointment, clinicName: string): string {
  const when = fmtDateTime(a.startsAt);
  const who = a.staffName ? ` with ${a.staffName}` : '';
  return (
    `Hello ${a.patientName},\n\n` +
    `This is a reminder of your appointment at ${clinicName} on ${when}${who}.\n` +
    `Reason: ${a.reason}\n\n` +
    `Please let us know if you need to reschedule.`
  );
}

export default function AppointmentModal({
  initialStart,
  initialOperatoryId,
  appointment,
  staff,
  onClose,
  onSaved,
}: {
  initialStart?: Date;
  initialOperatoryId?: string;
  appointment?: Appointment;
  staff: StaffMember[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { user, can } = useAuth();
  const editing = Boolean(appointment);
  const canWrite = can('appointments:write');

  const start = appointment ? new Date(appointment.startsAt) : (initialStart ?? new Date());
  const initialDuration = appointment
    ? Math.round(
        (new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60000,
      )
    : 45;

  const [patientId, setPatientId] = useState(appointment?.patientId ?? '');
  const [patientName, setPatientName] = useState(appointment?.patientName ?? '');
  const [staffId, setStaffId] = useState(appointment?.staffId ?? '');
  const [operatoryId, setOperatoryId] = useState(
    appointment?.operatoryId ?? initialOperatoryId ?? '',
  );
  const [date, setDate] = useState(toLocalISO(start).slice(0, 10));
  const [time, setTime] = useState(toLocalISO(start).slice(11, 16));
  const [duration, setDuration] = useState(initialDuration);
  const [reason, setReason] = useState(appointment?.reason ?? '');

  const [rooms, setRooms] = useState<Operatory[]>([]);
  const [transitions, setTransitions] = useState<Record<string, ApptStatus[]>>({});
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [history, setHistory] = useState<StatusEvent[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  useEffect(() => {
    operatoriesApi.list().then(setRooms).catch(() => setRooms([]));
    appointmentsApi.statuses().then((s) => setTransitions(s.transitions)).catch(() => setTransitions({}));
  }, []);

  useEffect(() => {
    if (!appointment) return;
    remindersApi.list(appointment.id).then(setReminders).catch(() => setReminders([]));
  }, [appointment]);

  const nextStatuses = useMemo(
    () => (appointment ? transitions[appointment.status] ?? [] : []),
    [appointment, transitions],
  );

  async function move(to: ApptStatus, reasonText?: string) {
    if (!appointment) return;
    setError(null);
    setBusy(true);
    try {
      await appointmentsApi.transition(appointment.id, to, { reason: reasonText });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the status.');
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!patientId) { setError('Choose a patient'); return; }
    setError(null);
    setBusy(true);
    try {
      const startsAt = `${date}T${time}:00`;
      const endDate = new Date(startsAt);
      endDate.setMinutes(endDate.getMinutes() + duration);
      const endsAt = toLocalISO(endDate);
      const payload = {
        patientId,
        staffId: staffId || undefined,
        operatoryId: operatoryId || undefined,
        startsAt,
        endsAt,
        reason,
      };
      if (editing) await appointmentsApi.update(appointment!.id, payload);
      else await appointmentsApi.create(payload);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the appointment.');
      setBusy(false);
    }
  }

  async function openHistory() {
    setShowHistory(true);
    if (history === null && appointment) {
      appointmentsApi.history(appointment.id).then(setHistory).catch(() => setHistory([]));
    }
  }

  /* ── hand-off to WhatsApp / mail app ──
     No provider is connected: the clinic sends from its own account so the
     patient recognises the sender. We record that the message was handed off,
     never that it was delivered — only the person who pressed send knows that. */
  const message = appointment ? composeReminder(appointment, user?.clinicName ?? 'our clinic') : '';
  const waNumber = whatsappNumber(appointment?.patientPhone ?? null);
  const waHref = waNumber
    ? `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`
    : null;
  const mailHref = appointment?.patientEmail
    ? `mailto:${encodeURIComponent(appointment.patientEmail)}` +
      `?subject=${encodeURIComponent(`Appointment reminder — ${user?.clinicName ?? ''}`.trim())}` +
      `&body=${encodeURIComponent(message)}`
    : null;

  async function recordHandoff(channel: 'whatsapp' | 'email') {
    if (!appointment) return;
    try {
      await remindersApi.sendManual(appointment.id, channel);
      setReminders(await remindersApi.list(appointment.id));
    } catch {
      // The message still opened; failing to log it must not block the staff.
    }
  }

  return (
    <Modal
      wide
      title={editing ? 'Appointment' : 'New appointment'}
      subtitle={
        editing
          ? `${appointment!.patientName} · ${fmtDateTime(appointment!.startsAt)}`
          : undefined
      }
      onClose={onClose}
    >
      <form className="modal__body" onSubmit={submit}>
        {editing && (
          <div className="apptstate">
            <StatusPill status={appointment!.status} />
            {appointment!.rescheduledAt && (
              <span className="cell-sub">Rescheduled {fmtTime(appointment!.rescheduledAt)}</span>
            )}
            {appointment!.cancelReason && (
              <span className="cell-sub">Reason: {appointment!.cancelReason}</span>
            )}
            <button type="button" className="btn btn--ghost btn--sm" onClick={openHistory}>
              <History size={14} /> History
            </button>
          </div>
        )}

        {editing && canWrite && nextStatuses.length > 0 && !cancelling && (
          <div className="apptactions">
            {nextStatuses.map((s) =>
              s === 'cancelled' ? (
                <button
                  key={s}
                  type="button"
                  className="btn btn--danger-ghost btn--sm"
                  onClick={() => setCancelling(true)}
                  disabled={busy}
                >
                  Cancel appointment
                </button>
              ) : (
                <button
                  key={s}
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => move(s)}
                  disabled={busy}
                >
                  {s === 'checked_in' && '→ '}
                  Mark {t(`appt.status.${s}`).toLowerCase()}
                </button>
              ),
            )}
          </div>
        )}

        {cancelling && (
          <div className="inlineform">
            <label className="field">
              <span>Why is this being cancelled? (required)</span>
              <input
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Patient rescheduled, illness, clinic closure…"
                autoFocus
              />
            </label>
            <div className="inlineform__foot">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCancelling(false)}>
                Keep appointment
              </button>
              <button
                type="button"
                className="btn btn--danger-ghost btn--sm"
                disabled={busy || !cancelReason.trim()}
                onClick={() => move('cancelled', cancelReason.trim())}
              >
                Confirm cancellation
              </button>
            </div>
          </div>
        )}

        {showHistory && (
          <div className="modal-reminders">
            <div className="modal-reminders__head">
              <span className="lineitems__title">Status history</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowHistory(false)}>
                Hide
              </button>
            </div>
            {history === null ? (
              <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Loading…</p>
            ) : history.length === 0 ? (
              <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>No changes recorded.</p>
            ) : (
              <ul className="modal-reminders__list">
                {history.map((h) => (
                  <li key={h.id}>
                    <StatusPill status={h.toStatus} />
                    <span>
                      {h.fromStatus ? `from ${t(`appt.status.${h.fromStatus}`)} · ` : 'created · '}
                      {h.actorName ?? 'Staff'} ·{' '}
                      {new Date(h.createdAt).toLocaleString(dateLocale(), {
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                      })}
                      {h.note ? ` · ${h.note}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <PatientPicker
          value={patientName}
          onPick={(p) => { setPatientId(p.id); setPatientName(`${p.firstName} ${p.lastName}`); }}
          onClear={() => { setPatientId(''); setPatientName(''); }}
        />

        <div className="grid2">
          <label className="field">
            <span>Practitioner</span>
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">Unassigned</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}{s.position ? ` · ${s.position}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span><DoorOpen size={13} style={{ verticalAlign: '-2px' }} /> Room</span>
            <select value={operatoryId} onChange={(e) => setOperatoryId(e.target.value)}>
              <option value="">No room assigned</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid2">
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>Start time</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
          </label>
        </div>

        <label className="field">
          <span><Clock size={13} style={{ verticalAlign: '-2px' }} /> Duration</span>
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d} value={d}>{d} minutes</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Reason</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. General checkup, Root canal — session 2"
            required
            maxLength={200}
          />
        </label>

        {editing && (
          <div className="modal-reminders">
            <div className="modal-reminders__head">
              <span className="lineitems__title">
                <BellRing size={14} style={{ verticalAlign: '-2px' }} /> Send a reminder
              </span>
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 8px' }}>
              Opens your own WhatsApp or mail app with the message ready to send,
              so it arrives from the clinic's own number or address.
            </p>
            <div className="sendrow">
              {waHref ? (
                <a
                  className="btn btn--ghost btn--sm"
                  href={waHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => recordHandoff('whatsapp')}
                >
                  <MessageCircle size={14} /> WhatsApp
                </a>
              ) : (
                <span className="cell-sub">No usable phone number on file</span>
              )}
              {mailHref ? (
                <a
                  className="btn btn--ghost btn--sm"
                  href={mailHref}
                  onClick={() => recordHandoff('email')}
                >
                  <Mail size={14} /> Email
                </a>
              ) : (
                <span className="cell-sub">No email on file</span>
              )}
            </div>

            {reminders && reminders.length > 0 && (
              <ul className="modal-reminders__list" style={{ marginTop: 10 }}>
                {reminders.slice(0, 5).map((r) => (
                  <li key={r.id}>
                    <StatusPill
                      status={r.status === 'sent' ? 'completed' : r.status === 'failed' ? 'no_show' : 'scheduled'}
                      label={r.status === 'sent' ? 'Handed off' : r.status === 'failed' ? 'Failed' : 'Pending'}
                    />
                    <span>
                      {r.type === 'automatic' ? 'Automatic' : 'Manual'} ·{' '}
                      {new Date(r.createdAt).toLocaleString(dateLocale(), {
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && <p className="formerror">{error}</p>}

        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Close</button>
            {canWrite && appointment?.status !== 'completed' && (
              <button className="btn btn--primary" disabled={busy}>
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Book appointment'}
              </button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
