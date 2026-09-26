import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  BellRing,
  Check,
  Clock,
  DoorOpen,
  History,
  Mail,
  MessageCircle,
  Smartphone,
} from 'lucide-react';
import {
  ApiError,
  api,
  appointmentsApi,
  closuresApi,
  operatoriesApi,
  remindersApi,
  treatmentsApi,
  type Closure,
  type Appointment,
  type ApptStatus,
  type Operatory,
  type Patient,
  type Reminder,
  type StaffMember,
  type StatusEvent,
  type Treatment,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, SidePanel, StatusPill } from './ui';
import PatientPicker from './PatientPicker';
import { dateLocale } from '../lib/strings';
import { t } from '../lib/strings';
import { channelLabel, reminderState } from '../lib/reminders';

const DURATIONS = [15, 20, 30, 45, 60, 90, 120];

function toLocalISO(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString(dateLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
}
function fmtDateTime(s: string) {
  return new Date(s).toLocaleString(dateLocale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function fmtStamp(s: string) {
  return new Date(s).toLocaleString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
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

/** One numbered step of the booking form. The number turns into a tick once
 *  the step has what it needs, so the receptionist can see what is missing. */
function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: ReactNode;
}) {
  return (
    <li className={`step${done ? ' step--done' : ''}`}>
      <span className="step__num" aria-hidden>
        {done ? <Check size={16} /> : n}
      </span>
      <div className="step__body">
        <h3 className="step__title">
          {title}
          {done && <span className="sr-only"> (complete)</span>}
        </h3>
        {children}
      </div>
    </li>
  );
}

/**
 * Booking and editing an appointment.
 *
 * A side panel rather than a centred modal: the calendar it was opened from
 * stays visible beside it on a desktop, so the receptionist can see the gap
 * they are filling. On a phone it takes the whole screen. The form is three
 * numbered steps — what for, who, when — in the order a phone call goes.
 */
export default function AppointmentModal({
  initialStart,
  initialOperatoryId,
  initialPatientId,
  initialStaffId,
  appointment,
  staff,
  onClose,
  onSaved,
}: {
  initialStart?: Date;
  initialOperatoryId?: string;
  /** Pre-selects the patient when booking from their record. */
  initialPatientId?: string;
  /** Pre-selects the practitioner when booking from their calendar column. */
  initialStaffId?: string;
  appointment?: Appointment;
  staff: StaffMember[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { user, can } = useAuth();
  const editing = Boolean(appointment);
  const canWrite = can('appointments:write');

  const start = appointment
    ? new Date(appointment.startsAt)
    : (initialStart ?? new Date());
  const initialDuration = appointment
    ? Math.round(
        (new Date(appointment.endsAt).getTime() -
          new Date(appointment.startsAt).getTime()) /
          60000,
      )
    : 45;

  const [patientId, setPatientId] = useState(
    appointment?.patientId ?? initialPatientId ?? '',
  );
  const [patientName, setPatientName] = useState(appointment?.patientName ?? '');
  const [staffId, setStaffId] = useState(appointment?.staffId ?? initialStaffId ?? '');
  const [operatoryId, setOperatoryId] = useState(
    appointment?.operatoryId ?? initialOperatoryId ?? '',
  );
  const [date, setDate] = useState(toLocalISO(start).slice(0, 10));
  const [time, setTime] = useState(toLocalISO(start).slice(11, 16));
  const [duration, setDuration] = useState(initialDuration);
  const [reason, setReason] = useState(appointment?.reason ?? '');
  const [treatmentId, setTreatmentId] = useState('');

  const [rooms, setRooms] = useState<Operatory[]>([]);
  const [treatments, setTreatments] = useState<Treatment[]>([]);
  const [patientInfo, setPatientInfo] = useState<Patient | null>(null);
  const [patientLoading, setPatientLoading] = useState(false);
  const [transitions, setTransitions] = useState<Record<string, ApptStatus[]>>({});
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const { can: canDo } = useAuth();
  const [smsAvailable, setSmsAvailable] = useState(false);
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [history, setHistory] = useState<StatusEvent[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  useEffect(() => {
    operatoriesApi
      .list()
      .then(setRooms)
      .catch(() => setRooms([]));
    appointmentsApi
      .statuses()
      .then((s) => setTransitions(s.transitions))
      .catch(() => setTransitions({}));
    // The catalogue only fills in the reason and the duration. If it cannot
    // load, the step simply has no picker and the reason is typed.
    treatmentsApi
      .list({ status: 'active' })
      .then(setTreatments)
      .catch(() => setTreatments([]));
  }, []);

  useEffect(() => {
    if (!appointment) return;
    remindersApi
      .list(appointment.id)
      .then(setReminders)
      .catch(() => setReminders([]));
    remindersApi
      .channels()
      .then((c) => setSmsAvailable(c.sms))
      .catch(() => setSmsAvailable(false));
  }, [appointment]);

  // The chosen patient's contact card. Also how a patient linked from their
  // record gets a name in the picker.
  useEffect(() => {
    if (!patientId) {
      setPatientInfo(null);
      setPatientLoading(false);
      return;
    }
    let off = false;
    setPatientLoading(true);
    api
      .getPatient(patientId)
      .then((p) => {
        if (off) return;
        setPatientInfo(p);
        setPatientName((cur) => cur || `${p.firstName} ${p.lastName}`);
      })
      .catch(() => {
        if (!off) setPatientInfo(null);
      })
      .finally(() => {
        if (!off) setPatientLoading(false);
      });
    return () => {
      off = true;
    };
  }, [patientId]);

  // A holiday or time off on the chosen day. A warning, not a refusal: an
  // emergency on a closed day is still an appointment.
  const [closures, setClosures] = useState<Closure[]>([]);
  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let off = false;
    closuresApi
      .list(date, date)
      .then((c) => !off && setClosures(c))
      .catch(() => !off && setClosures([]));
    return () => {
      off = true;
    };
  }, [date]);
  const closure = closures.find((c) => c.staffId === null || c.staffId === staffId) ?? null;

  const nextStatuses = useMemo(
    () => (appointment ? (transitions[appointment.status] ?? []) : []),
    [appointment, transitions],
  );

  const durationOptions = useMemo(
    () => [...new Set([...DURATIONS, duration])].sort((a, b) => a - b),
    [duration],
  );

  const endsAtLabel = useMemo(() => {
    const d = new Date(`${date}T${time}:00`);
    if (Number.isNaN(d.getTime())) return null;
    d.setMinutes(d.getMinutes() + duration);
    return d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  }, [date, time, duration]);

  function pickTreatment(id: string) {
    setTreatmentId(id);
    const tr = treatments.find((x) => x.id === id);
    if (!tr) return;
    // Fill, never overwrite: a reason someone typed themselves is theirs.
    setReason((cur) =>
      !cur.trim() || treatments.some((x) => x.name === cur) ? tr.name : cur,
    );
    setDuration(tr.durationMinutes);
  }

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
    if (!patientId) {
      setError('Choose a patient');
      return;
    }
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

  async function toggleHistory() {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    setShowHistory(true);
    if (history === null && appointment) {
      appointmentsApi
        .history(appointment.id)
        .then(setHistory)
        .catch(() => setHistory([]));
    }
  }

  /* ── hand-off to WhatsApp / mail app ──
     No provider is connected: the clinic sends from its own account so the
     patient recognises the sender. We record that the message was handed off,
     never that it was delivered — only the person who pressed send knows that. */
  const message = appointment
    ? composeReminder(appointment, user?.clinicName ?? 'our clinic')
    : '';
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

  /* ── SMS through the provider ──
     Unlike the hand-offs above, this server sends it. The row that comes back
     says what happened: sent, or failed with the reason. */
  async function sendSms() {
    if (!appointment) return;
    setSmsError(null);
    setSmsBusy(true);
    try {
      const r = await remindersApi.sendManual(appointment.id, 'sms');
      if (r.status === 'failed') setSmsError(r.error ?? 'The SMS could not be sent.');
      setReminders(await remindersApi.list(appointment.id));
    } catch (err) {
      setSmsError(err instanceof ApiError ? err.message : 'The SMS could not be sent.');
    } finally {
      setSmsBusy(false);
    }
  }

  const canSave = canWrite && appointment?.status !== 'completed';
  const allergies = patientInfo?.allergySummary;

  return (
    <SidePanel
      title={editing ? appointment!.patientName : 'New appointment'}
      subtitle={
        editing
          ? fmtDateTime(appointment!.startsAt)
          : 'What it is for, who is coming, and when.'
      }
      onClose={onClose}
    >
      <form className="panel__form" onSubmit={submit}>
        <div className="panel__body">
          {editing && (
            <div className="apptstate">
              <StatusPill status={appointment!.status} />
              {appointment!.rescheduledAt && (
                <span className="cell-sub">
                  Rescheduled {fmtTime(appointment!.rescheduledAt)}
                </span>
              )}
              {appointment!.cancelReason && (
                <span className="cell-sub">Reason: {appointment!.cancelReason}</span>
              )}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={toggleHistory}
                aria-expanded={showHistory}
              >
                <History size={14} aria-hidden /> {showHistory ? 'Hide history' : 'History'}
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
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setCancelling(false)}
                >
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
            <section className="panel__section" aria-label="Status history">
              <h3 className="panel__section-title">Status history</h3>
              {history === null ? (
                <p className="formhint">Loading…</p>
              ) : history.length === 0 ? (
                <p className="formhint">No changes recorded.</p>
              ) : (
                <ul className="eventlist">
                  {history.map((h) => (
                    <li key={h.id}>
                      <StatusPill status={h.toStatus} />
                      <span>
                        {h.fromStatus
                          ? `from ${t(`appt.status.${h.fromStatus}`)} · `
                          : 'created · '}
                        {h.actorName ?? 'Staff'} · {fmtStamp(h.createdAt)}
                        {h.note ? ` · ${h.note}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <ol className="steps">
            <Step n={1} title="Service" done={Boolean(reason.trim())}>
              {treatments.length > 0 && (
                <label className="field">
                  <span>From the treatment catalogue</span>
                  <select value={treatmentId} onChange={(e) => pickTreatment(e.target.value)}>
                    <option value="">Choose a treatment (optional)</option>
                    {treatments.map((tr) => (
                      <option key={tr.id} value={tr.id}>
                        {tr.name} · {tr.durationMinutes} min
                      </option>
                    ))}
                  </select>
                </label>
              )}
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
            </Step>

            <Step n={2} title="Patient" done={Boolean(patientId)}>
              <PatientPicker
                value={patientName}
                onPick={(p) => {
                  setPatientId(p.id);
                  setPatientName(`${p.firstName} ${p.lastName}`);
                }}
                onClear={() => {
                  setPatientId('');
                  setPatientName('');
                }}
              />
              {patientId && (
                <div className="contactcard">
                  <Avatar name={patientName || '?'} size={40} />
                  <div className="contactcard__main">
                    <span className="contactcard__name">{patientName || '…'}</span>
                    {patientInfo ? (
                      <>
                        <dl className="contactcard__rows">
                          <dt>Phone</dt>
                          <dd>{patientInfo.phone ?? 'Not recorded'}</dd>
                          <dt>Email</dt>
                          <dd>{patientInfo.email ?? 'Not recorded'}</dd>
                          <dt>Address</dt>
                          <dd>
                            {[patientInfo.address, patientInfo.city]
                              .filter(Boolean)
                              .join(', ') || 'Not recorded'}
                          </dd>
                        </dl>
                        {allergies && allergies.hasSevere && (
                          <span className="pill pill--danger">
                            <AlertTriangle size={13} aria-hidden /> Severe allergy:{' '}
                            {allergies.substances.join(', ')}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="formhint">
                        {patientLoading
                          ? 'Loading contact details…'
                          : 'Contact details are not available.'}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </Step>

            <Step n={3} title="Time & date" done={Boolean(date && time)}>
              <div className="grid2">
                <label className="field">
                  <span>Date</span>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Start time</span>
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    required
                  />
                </label>
              </div>
              <label className="field">
                <span>
                  <Clock size={13} aria-hidden /> Duration
                </span>
                <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                  {durationOptions.map((d) => (
                    <option key={d} value={d}>
                      {d} minutes
                    </option>
                  ))}
                </select>
              </label>
              {endsAtLabel && <p className="formhint">Ends at {endsAtLabel}</p>}
              {closure && (
                <p className="formerror" role="status">
                  <AlertTriangle size={13} aria-hidden />{' '}
                  {closure.staffId ? `${closure.staffName ?? 'This practitioner'} is away` : 'The clinic is closed'} that day:{' '}
                  {closure.reason}. It can still be booked, if that is intended.
                </p>
              )}
              <div className="grid2">
                <label className="field">
                  <span>Practitioner</span>
                  <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                    <option value="">Unassigned</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.fullName}
                        {s.position ? ` · ${s.position}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>
                    <DoorOpen size={13} aria-hidden /> Room
                  </span>
                  <select value={operatoryId} onChange={(e) => setOperatoryId(e.target.value)}>
                    <option value="">No room assigned</option>
                    {rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </Step>
          </ol>

          {editing && (
            <section className="panel__section" aria-labelledby="appt-remind">
              <h3 className="panel__section-title" id="appt-remind">
                <span>
                  <BellRing size={13} aria-hidden /> Send a reminder
                </span>
              </h3>
              <p className="formhint">
                {smsAvailable
                  ? 'SMS is sent by the system now. WhatsApp and Email open your own app with the message ready, so it arrives from the clinic’s own number or address.'
                  : "Opens your own WhatsApp or mail app with the message ready to send, so it arrives from the clinic's own number or address."}
              </p>
              {patientInfo?.remindersOptOut && (
                <p className="formhint">
                  <AlertTriangle size={13} aria-hidden /> This patient has opted out of
                  reminders
                  {patientInfo.remindersOptOutSource === 'patient'
                    ? ' — they replied STOP to one.'
                    : patientInfo.remindersOptOutSource === 'provider'
                      ? ' — the SMS provider reports the number unsubscribed.'
                      : '.'}
                </p>
              )}
              <div className="sendrow">
                {smsAvailable && canDo('reminders:send') && !patientInfo?.remindersOptOut && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={smsBusy}
                    onClick={() => void sendSms()}
                  >
                    <Smartphone size={14} aria-hidden /> {smsBusy ? 'Sending…' : 'SMS'}
                  </button>
                )}
                {waHref ? (
                  <a
                    className="btn btn--ghost btn--sm"
                    href={waHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => recordHandoff('whatsapp')}
                  >
                    <MessageCircle size={14} aria-hidden /> WhatsApp
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
                    <Mail size={14} aria-hidden /> Email
                  </a>
                ) : (
                  <span className="cell-sub">No email on file</span>
                )}
              </div>
              {smsError && (
                <p className="formerror" role="alert">
                  {smsError}
                </p>
              )}

              {reminders && reminders.length > 0 && (
                <ul className="eventlist">
                  {reminders.slice(0, 5).map((r) => {
                    const state = reminderState(r);
                    return (
                      <li key={r.id}>
                        <StatusPill status={state.status} label={state.label} />
                        <span>
                          {channelLabel(r.channel)} ·{' '}
                          {r.type === 'automatic' ? 'Automatic' : 'Manual'} ·{' '}
                          {fmtStamp(r.createdAt)}
                          {(r.status === 'failed' || r.status === 'skipped') && r.error
                            ? ` — ${r.error}`
                            : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
        </div>

        <div className="panel__foot">
          {error && (
            <p className="formerror" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          {canSave && (
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Book appointment'}
            </button>
          )}
        </div>
      </form>
    </SidePanel>
  );
}
