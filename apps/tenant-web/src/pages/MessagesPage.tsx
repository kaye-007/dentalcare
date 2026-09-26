import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronLeft,
  Clock,
  Copy,
  MessageCircle,
  NotebookPen,
  Plus,
  Search,
  Send,
  Smartphone,
  UserRound,
  X,
} from 'lucide-react';
import {
  MESSAGE_PURPOSES,
  MESSAGE_PURPOSE_NAMES,
  defaultMessageTemplate,
  renderMessage,
  smsSegments,
  type MessagePurpose,
} from '@dentalcare/shared';
import {
  ApiError,
  messagesApi,
  type Conversation,
  type ConversationFilter,
  type MessageThread,
  type Reminder,
  type SendChannel,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { channelLabel, reminderState } from '../lib/reminders';
import { dateLocale } from '../lib/strings';
import { Avatar, EmptyState, Modal, PageHeader } from '../components/ui';
import PatientPicker from '../components/PatientPicker';

/**
 * Messages: every WhatsApp, Viber and SMS message the clinic has sent, one
 * conversation per patient.
 *
 *   left     the conversations, filtered by channel (the buttons across the
 *            top), by kind of message, or by a name or number
 *   right    the selected patient's messages exactly as they were sent — the
 *            text, the channel, who sent it, and whether it arrived; select a
 *            message for its delivery details
 *   bottom   send one of the clinic's messages: an appointment reminder, a
 *            post-procedure follow-up or an unpaid-balance notice, previewed
 *            word for word before it goes
 *
 * Messages leave the clinic; they do not come back. Replies go to the
 * provider's inbox or the clinic's own phone, so this is a record of what was
 * said and whether it was delivered, not a two-way chat.
 */

const FILTERS: { key: ConversationFilter; label: string }[] = [
  { key: 'all', label: 'All chats' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'viber', label: 'Viber' },
  { key: 'sms', label: 'SMS' },
  { key: 'other', label: 'Recorded' },
];

const PURPOSE_SHORT: Record<MessagePurpose, string> = {
  appointment_reminder: 'Reminder',
  post_procedure_followup: 'Follow-up',
  unpaid_balance: 'Balance',
};

const POLL_MS = 30_000;

function channelKind(channel: string): 'whatsapp' | 'viber' | 'sms' | 'other' {
  if (channel === 'whatsapp_business' || channel === 'whatsapp') return 'whatsapp';
  if (channel === 'viber') return 'viber';
  if (channel === 'sms') return 'sms';
  return 'other';
}

function ChannelBadge({ channel }: { channel: string }) {
  return (
    <span className={`chanbadge chanbadge--${channelKind(channel)}`}>
      {channelLabel(channel)}
    </span>
  );
}

function StatusIcon({ message }: { message: Pick<Reminder, 'status' | 'channel'> }) {
  switch (message.status) {
    case 'delivered':
      return (
        <CheckCheck size={14} className="msgstatus msgstatus--delivered" aria-hidden />
      );
    case 'sent':
      return <Check size={14} className="msgstatus" aria-hidden />;
    case 'failed':
      return (
        <AlertTriangle size={14} className="msgstatus msgstatus--failed" aria-hidden />
      );
    case 'skipped':
      return <X size={14} className="msgstatus" aria-hidden />;
    default:
      return <Clock size={14} className="msgstatus" aria-hidden />;
  }
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(dateLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export default function MessagesPage() {
  const { can, readOnly } = useAuth();
  const canSend = can('reminders:send') && !readOnly;
  const [params, setParams] = useSearchParams();
  const selected = params.get('patient');
  const filter = (params.get('channel') as ConversationFilter | null) ?? 'all';
  const purposeFilter = params.get('show') as MessagePurpose | null;

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === null) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: key !== 'patient' },
      );
    },
    [setParams],
  );

  const loadList = useCallback(() => {
    messagesApi
      .conversations({
        channel: filter,
        purpose: purposeFilter ?? undefined,
        q: debouncedQ,
      })
      .then((list) => {
        setConversations(list);
        setListError(null);
      })
      .catch((e) =>
        setListError(
          e instanceof ApiError ? e.message : 'The conversations could not be loaded.',
        ),
      );
  }, [filter, purposeFilter, debouncedQ]);

  useEffect(() => {
    setConversations(null);
    loadList();
  }, [loadList]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadList();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadList]);

  const counts = useMemo(() => {
    const failed = (conversations ?? []).reduce((s, c) => s + c.failedCount, 0);
    return { total: conversations?.length ?? 0, failed };
  }, [conversations]);

  return (
    <div className="page page--wide">
      <PageHeader
        title="Messages"
        meta={
          conversations
            ? `${counts.total} conversation${counts.total === 1 ? '' : 's'}${counts.failed ? ` · ${counts.failed} failed` : ''}`
            : '…'
        }
        actions={
          canSend ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setPicking(true)}
            >
              <Plus size={16} aria-hidden /> New message
            </button>
          ) : undefined
        }
      />

      <div className={`chats${selected ? ' chats--open' : ''}`}>
        <aside className="card chats__list" aria-label="Conversations">
          <div className="chats__filters" role="group" aria-label="Show chats from">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`chip chats__filter--${f.key}${filter === f.key ? ' chip--on' : ''}`}
                aria-pressed={filter === f.key}
                onClick={() => setParam('channel', f.key === 'all' ? null : f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="chats__tools">
            <label className="searchbox">
              <Search size={15} aria-hidden />
              <span className="sr-only">Search conversations</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Name or phone…"
              />
            </label>
            <select
              className="select--bare"
              value={purposeFilter ?? ''}
              onChange={(e) => setParam('show', e.target.value || null)}
              aria-label="Kind of message"
            >
              <option value="">All kinds</option>
              {MESSAGE_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {MESSAGE_PURPOSE_NAMES[p]}
                </option>
              ))}
            </select>
          </div>

          {listError && <p className="formerror pad">{listError}</p>}
          {conversations === null && !listError ? (
            <p className="pad muted">Loading conversations…</p>
          ) : conversations && conversations.length === 0 ? (
            <EmptyState
              icon={<MessageCircle size={20} />}
              title={
                filter === 'all' && !debouncedQ && !purposeFilter
                  ? 'No messages yet'
                  : 'No chats match'
              }
              body={
                filter === 'all' && !debouncedQ && !purposeFilter
                  ? 'Reminders, follow-ups and balance notices sent to patients appear here.'
                  : 'Try another channel or clear the search.'
              }
            />
          ) : (
            <ul className="chats__items">
              {conversations?.map((c) => (
                <li key={c.patientId}>
                  <button
                    type="button"
                    className={`chatrow${selected === c.patientId ? ' chatrow--active' : ''}`}
                    onClick={() => setParam('patient', c.patientId)}
                    aria-current={selected === c.patientId ? 'true' : undefined}
                  >
                    <Avatar name={c.patientName} size={36} />
                    <span className="chatrow__main">
                      <span className="chatrow__top">
                        <span className="chatrow__name">{c.patientName}</span>
                        <span className="chatrow__time">
                          {shortTime(c.last.createdAt)}
                        </span>
                      </span>
                      <span className="chatrow__last">
                        <StatusIcon message={c.last} />
                        <span className="chatrow__snippet">{c.last.message}</span>
                      </span>
                      <span className="chatrow__meta">
                        <ChannelBadge channel={c.last.channel} />
                        <span className="chatrow__kind">
                          {PURPOSE_SHORT[c.last.purpose]}
                        </span>
                        {c.failedCount > 0 && (
                          <span className="chatrow__failed">{c.failedCount} failed</span>
                        )}
                        {c.optedOut && <span className="chatrow__failed">opted out</span>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="card chats__thread" aria-label="Conversation">
          {selected ? (
            <Thread
              key={selected}
              patientId={selected}
              canSend={canSend}
              initialPurpose={params.get('purpose') as MessagePurpose | null}
              onBack={() => setParam('patient', null)}
              onSent={loadList}
            />
          ) : (
            <EmptyState
              icon={<MessageCircle size={22} />}
              title="Select a chat"
              body="Choose a conversation on the left to see every message sent to that patient, or start a new one."
            />
          )}
        </section>
      </div>

      {picking && (
        <Modal
          title="New message"
          subtitle="Choose the patient to write to."
          onClose={() => setPicking(false)}
        >
          <div className="modal__body">
            <PatientPicker
              value=""
              onPick={(p) => {
                setPicking(false);
                setParam('patient', p.id);
              }}
              onClear={() => undefined}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── one conversation ───────────────────────────────────── */

function Thread({
  patientId,
  canSend,
  initialPurpose,
  onBack,
  onSent,
}: {
  patientId: string;
  canSend: boolean;
  initialPurpose: MessagePurpose | null;
  onBack: () => void;
  onSent: () => void;
}) {
  const [thread, setThread] = useState<MessageThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      messagesApi
        .thread(patientId)
        .then((t) => {
          setThread(t);
          setError(null);
        })
        .catch((e) =>
          setError(
            e instanceof ApiError ? e.message : 'The conversation could not be loaded.',
          ),
        ),
    [patientId],
  );

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const count = thread?.messages.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  if (error) {
    return (
      <div className="pad">
        <button
          type="button"
          className="btn btn--ghost btn--sm chats__back"
          onClick={onBack}
        >
          <ChevronLeft size={15} aria-hidden /> Chats
        </button>
        <p className="formerror">{error}</p>
      </div>
    );
  }
  if (!thread) return <p className="pad muted">Loading the conversation…</p>;

  const name = `${thread.patient.firstName} ${thread.patient.lastName}`;
  const groups: { day: string; items: Reminder[] }[] = [];
  for (const m of thread.messages) {
    const day = new Date(m.createdAt).toDateString();
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(m);
    else groups.push({ day, items: [m] });
  }

  return (
    <>
      <header className="thread__head">
        <button
          type="button"
          className="iconbtn chats__back"
          onClick={onBack}
          aria-label="Back to chats"
        >
          <ChevronLeft size={18} />
        </button>
        <Avatar name={name} size={40} />
        <div className="thread__who">
          <strong>{name}</strong>
          <span className="muted">
            {thread.patient.e164 ??
              (thread.patient.phone
                ? `${thread.patient.phone} (not a usable mobile number)`
                : 'No phone on file')}
            {thread.patient.preferredChannel
              ? ` · prefers ${channelLabel(thread.patient.preferredChannel)}`
              : ''}
          </span>
        </div>
        <Link to={`/patients/${patientId}`} className="btn btn--ghost btn--sm">
          <UserRound size={14} aria-hidden /> Record
        </Link>
      </header>

      {thread.patient.optedOut && (
        <p className="thread__notice">
          <AlertTriangle size={14} aria-hidden /> {thread.patient.firstName} has asked not
          to receive messages
          {thread.patient.optOutSource === 'patient' ? ' (replied STOP)' : ''}. Nothing
          can be sent to their phone.
        </p>
      )}

      <div className="thread__body" aria-live="polite">
        {groups.length === 0 ? (
          <p className="thread__empty muted">
            No messages have been sent to {thread.patient.firstName} yet.
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.day}>
              <p className="thread__day">{dayLabel(g.items[0]!.createdAt)}</p>
              {g.items.map((m) => (
                <Bubble
                  key={m.id}
                  message={m}
                  open={open === m.id}
                  onToggle={() => setOpen(open === m.id ? null : m.id)}
                />
              ))}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {canSend && (
        <Composer
          thread={thread}
          initialPurpose={initialPurpose}
          onSent={async () => {
            await load();
            onSent();
          }}
        />
      )}
    </>
  );
}

function Bubble({
  message: m,
  open,
  onToggle,
}: {
  message: Reminder;
  open: boolean;
  onToggle: () => void;
}) {
  const state = reminderState(m);
  const time = new Date(m.createdAt).toLocaleTimeString(dateLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
  const rows: [string, ReactNode][] = [
    ['Kind', MESSAGE_PURPOSE_NAMES[m.purpose]],
    ['Channel', channelLabel(m.channel)],
    [
      'Status',
      m.providerStatus ? `${state.label} (provider: ${m.providerStatus})` : state.label,
    ],
    ['To', m.toAddress ?? '—'],
    ['Sent by', m.type === 'automatic' ? 'Automatic reminder' : (m.sentByName ?? '—')],
    ['Created', new Date(m.createdAt).toLocaleString(dateLocale())],
  ];
  if (m.sentAt) rows.push(['Sent', new Date(m.sentAt).toLocaleString(dateLocale())]);
  if (m.deliveredAt)
    rows.push(['Delivered', new Date(m.deliveredAt).toLocaleString(dateLocale())]);
  if (m.appointmentStartsAt) {
    rows.push([
      'Appointment',
      new Date(m.appointmentStartsAt).toLocaleString(dateLocale(), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    ]);
  }
  if (m.attempts > 1) rows.push(['Attempts', String(m.attempts)]);
  if (m.nextAttemptAt)
    rows.push(['Next attempt', new Date(m.nextAttemptAt).toLocaleString(dateLocale())]);
  if (m.error)
    rows.push(['Problem', `${m.error}${m.errorCode ? ` (code ${m.errorCode})` : ''}`]);

  return (
    <div
      className={`bubble bubble--${channelKind(m.channel)}${m.status === 'failed' ? ' bubble--failed' : ''}`}
    >
      <button
        type="button"
        className="bubble__main"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="bubble__label">
          {MESSAGE_PURPOSE_NAMES[m.purpose]} · <ChannelBadge channel={m.channel} />
        </span>
        <span className="bubble__text">{m.message}</span>
        <span className="bubble__foot">
          {m.type === 'automatic' ? 'Automatic' : (m.sentByName ?? '')} · {time}{' '}
          <StatusIcon message={m} /> {state.label}
        </span>
      </button>
      {open && (
        <dl className="bubble__details">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/* ── composing ──────────────────────────────────────────── */

interface ChannelOption {
  id: SendChannel;
  label: string;
  icon: ReactNode;
  /** Why it cannot be used, or null when it can. */
  blocked: string | null;
  hint: string;
}

function Composer({
  thread,
  initialPurpose,
  onSent,
}: {
  thread: MessageThread;
  initialPurpose: MessagePurpose | null;
  onSent: () => Promise<void>;
}) {
  const { context, channels, patient, clinic } = thread;
  const [purpose, setPurpose] = useState<MessagePurpose>(
    initialPurpose ?? 'appointment_reminder',
  );
  const [appointmentId, setAppointmentId] = useState(context.upcoming[0]?.id ?? '');
  const [visitId, setVisitId] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [channel, setChannel] = useState<SendChannel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [handoffUrl, setHandoffUrl] = useState<string | null>(null);

  const options: ChannelOption[] = useMemo(() => {
    const phoneBlock = patient.optedOut
      ? 'The patient opted out'
      : !patient.e164
        ? 'No usable mobile number on file'
        : null;
    return [
      {
        id: 'whatsapp_business',
        label: 'WhatsApp',
        icon: <MessageCircle size={15} aria-hidden />,
        blocked:
          phoneBlock ??
          (!channels.whatsappBusiness
            ? 'WhatsApp Business is not set up on this deployment'
            : !channels.whatsappPurposes.includes(purpose)
              ? 'No approved WhatsApp template for this kind of message'
              : null),
        hint: 'Sent now as the approved WhatsApp template.',
      },
      {
        id: 'viber',
        label: 'Viber',
        icon: <MessageCircle size={15} aria-hidden />,
        blocked:
          phoneBlock ??
          (!channels.viber ? 'Viber is not set up on this deployment' : null),
        hint: 'Sent now through Viber Business Messages. Viber reports acceptance, not delivery.',
      },
      {
        id: 'sms',
        label: 'SMS',
        icon: <Smartphone size={15} aria-hidden />,
        blocked:
          phoneBlock ?? (!channels.sms ? 'SMS is not set up on this deployment' : null),
        hint: 'Sent now by SMS.',
      },
      {
        id: 'whatsapp',
        label: 'My WhatsApp',
        icon: <Send size={15} aria-hidden />,
        blocked: phoneBlock,
        hint: 'Opens WhatsApp on this device with the message ready; you press send there. Recorded as handed off.',
      },
      {
        id: 'log',
        label: 'Record only',
        icon: <NotebookPen size={15} aria-hidden />,
        blocked: null,
        hint: 'Nothing is sent. The message is recorded, for a call or a conversation at the desk.',
      },
    ];
  }, [channels, patient, purpose]);

  // Default to the first channel that can carry this message.
  useEffect(() => {
    const current = options.find((o) => o.id === channel);
    if (!current || current.blocked) {
      const preferred = options.find(
        (o) => o.id === (patient.preferredChannel ?? clinic.defaultChannel) && !o.blocked,
      );
      setChannel((preferred ?? options.find((o) => !o.blocked))?.id ?? null);
    }
  }, [options, channel, patient.preferredChannel, clinic.defaultChannel]);

  const selectedOption = options.find((o) => o.id === channel) ?? null;

  const draft = useMemo((): { text: string | null; problem: string | null } => {
    const base = {
      first_name: patient.firstName,
      clinic: clinic.name,
      clinic_phone: clinic.phone ?? '',
    };
    const hasPhone = Boolean(clinic.phone);
    let values: Record<string, string>;
    if (purpose === 'appointment_reminder') {
      const a = context.upcoming.find((x) => x.id === appointmentId);
      if (!a)
        return {
          text: null,
          problem: 'There is no upcoming appointment to remind the patient about.',
        };
      values = {
        ...base,
        date: a.date,
        time: a.time,
        dentist: a.dentist ?? '',
        clinic_address: clinic.address ?? '',
      };
    } else if (purpose === 'post_procedure_followup') {
      const v = visitId ? context.visits.find((x) => x.id === visitId) : null;
      const visit = v
        ? { visitDate: v.visitDate, dentist: v.dentist }
        : context.latestVisit;
      if (!visit)
        return {
          text: null,
          problem: 'This patient has no completed visit to follow up on.',
        };
      values = { ...base, visit_date: visit.visitDate, dentist: visit.dentist ?? '' };
    } else {
      const inv = invoiceId ? context.invoices.find((x) => x.id === invoiceId) : null;
      const owed = inv ? inv.balance : context.balance;
      if (owed <= 0)
        return {
          text: null,
          problem: 'Nothing is owed, so there is no balance to remind the patient of.',
        };
      values = { ...base, balance: inv ? inv.balanceText : context.balanceText };
    }
    // The same choice the server makes (composeMessage): the clinic's own
    // reminder wording, except where WhatsApp needs its approved template.
    const template =
      purpose === 'appointment_reminder' &&
      clinic.reminderTemplate &&
      channel !== 'whatsapp_business'
        ? clinic.reminderTemplate
        : defaultMessageTemplate(purpose, clinic.locale, hasPhone);
    return { text: renderMessage(template, purpose, values), problem: null };
  }, [
    purpose,
    appointmentId,
    visitId,
    invoiceId,
    channel,
    context,
    clinic,
    patient.firstName,
  ]);

  const segments = draft.text && channel === 'sms' ? smsSegments(draft.text) : null;

  async function send() {
    if (!channel || !draft.text) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setHandoffUrl(null);
    try {
      const out = await messagesApi.send(patient.id, {
        purpose,
        channel,
        appointmentId:
          purpose === 'appointment_reminder'
            ? appointmentId
            : purpose === 'post_procedure_followup'
              ? visitId || undefined
              : undefined,
        invoiceId: purpose === 'unpaid_balance' ? invoiceId || undefined : undefined,
      });
      // A link the person clicks, rather than a window opened for them: a
      // window opened after a request is a blocked pop-up.
      setHandoffUrl(out.handoffUrl);
      const state = reminderState(out.message);
      setNotice(
        out.message.status === 'failed'
          ? `Not sent: ${out.message.error ?? 'the provider refused it'}`
          : channel === 'whatsapp'
            ? 'Recorded as handed off. Open WhatsApp and press send there.'
            : `${MESSAGE_PURPOSE_NAMES[purpose]}: ${state.label.toLowerCase()}.`,
      );
      await onSent();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The message could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="composer">
      <div className="composer__row" role="group" aria-label="Kind of message">
        {MESSAGE_PURPOSES.map((p) => (
          <button
            key={p}
            type="button"
            className={`chip${purpose === p ? ' chip--on' : ''}`}
            aria-pressed={purpose === p}
            onClick={() => setPurpose(p)}
          >
            {MESSAGE_PURPOSE_NAMES[p]}
          </button>
        ))}
      </div>

      <div className="composer__row">
        {purpose === 'appointment_reminder' && context.upcoming.length > 0 && (
          <select
            value={appointmentId}
            onChange={(e) => setAppointmentId(e.target.value)}
            aria-label="Appointment"
          >
            {context.upcoming.map((a) => (
              <option key={a.id} value={a.id}>
                {a.date}, {a.time}
                {a.dentist ? ` · ${a.dentist}` : ''}
              </option>
            ))}
          </select>
        )}
        {purpose === 'post_procedure_followup' &&
          (context.visits.length > 0 || context.latestVisit) && (
            <select
              value={visitId}
              onChange={(e) => setVisitId(e.target.value)}
              aria-label="Visit"
            >
              {context.latestVisit && (
                <option value="">Latest visit · {context.latestVisit.visitDate}</option>
              )}
              {context.visits.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.visitDate}
                  {v.reason ? ` · ${v.reason}` : ''}
                </option>
              ))}
            </select>
          )}
        {purpose === 'unpaid_balance' && (
          <select
            value={invoiceId}
            onChange={(e) => setInvoiceId(e.target.value)}
            aria-label="Balance"
          >
            <option value="">Whole account · {context.balanceText}</option>
            {context.invoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.invoiceNumber} · {i.balanceText}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="composer__channels" role="radiogroup" aria-label="Send by">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={channel === o.id}
            className={`chanbtn chanbtn--${o.id}${channel === o.id ? ' chanbtn--on' : ''}`}
            disabled={Boolean(o.blocked)}
            title={o.blocked ?? o.hint}
            onClick={() => setChannel(o.id)}
          >
            {o.icon} {o.label}
          </button>
        ))}
      </div>

      {draft.problem ? (
        <p className="composer__problem">{draft.problem}</p>
      ) : (
        <div
          className={`bubble bubble--draft${channel ? ` bubble--${channelKind(channel)}` : ''}`}
        >
          <span className="bubble__label">
            Preview · exactly what the patient receives
          </span>
          <span className="bubble__text">{draft.text}</span>
          <span className="bubble__foot">
            {selectedOption?.hint}
            {segments
              ? ` ${segments.characters} characters, ${segments.segments} SMS part${segments.segments === 1 ? '' : 's'}.`
              : ''}
          </span>
        </div>
      )}

      {error && <p className="formerror">{error}</p>}
      {notice && (
        <p className="composer__notice">
          {notice}{' '}
          {handoffUrl && (
            <a
              className="btn btn--primary btn--sm"
              href={handoffUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Send size={14} aria-hidden /> Open WhatsApp
            </a>
          )}
        </p>
      )}

      <div className="composer__foot">
        {draft.text && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(draft.text!)
                .then(() => setNotice('Message copied.'))
            }
          >
            <Copy size={14} aria-hidden /> Copy text
          </button>
        )}
        <button
          type="button"
          className="btn btn--primary"
          onClick={send}
          disabled={busy || !channel || !draft.text || Boolean(selectedOption?.blocked)}
        >
          <Send size={15} aria-hidden />{' '}
          {busy ? 'Sending…' : channel === 'log' ? 'Record message' : 'Send message'}
        </button>
      </div>
    </div>
  );
}
