import { useEffect, useMemo, useState } from 'react';
import {
  History,
  Undo2,
  ReceiptText,
  Wallet,
  TrendingDown,
  UserCog,
  Settings2,
  Stethoscope,
  FileX,
  ClipboardList,
  Package,
} from 'lucide-react';
import { auditApi, type AuditEntry } from '../lib/api';
import { PageHeader, EmptyState, StatusPill, LoadingRows } from '../components/ui';
import { ROLE_LABELS, type Role } from '../lib/permissions';
import { dateLocale } from '../lib/strings';
import { clinicToday, inClinicZone, plusDays, toWall, wallNow } from '../lib/clinic-time';

/**
 * The clinic's activity trail — doctor-only.
 *
 * Everything here was written by the API in the same transaction as the thing
 * it describes, and nothing can amend it afterwards: the table has no UPDATE
 * or DELETE privilege and a trigger that refuses both. So this page is a
 * reader with filters, and deliberately has no controls that change anything.
 */

const GROUPS: { key: string; label: string; actions: string[] }[] = [
  {
    key: 'money',
    label: 'Money',
    actions: [
      'invoice.created',
      'invoice.cancelled',
      'invoice.adjusted',
      'payment.recorded',
      'payment.voided',
      'expense.recorded',
      'expense.voided',
    ],
  },
  {
    key: 'clinical',
    label: 'Clinical record',
    actions: [
      'patient.created',
      'patient.updated',
      'patient.archived',
      'patient.restored',
      'clinical.note_added',
      'clinical.note_withdrawn',
      'clinical.finding_recorded',
      'clinical.finding_updated',
      'clinical.finding_withdrawn',
      'clinical.procedure_logged',
      'clinical.procedure_updated',
      'clinical.procedure_signed',
      'clinical.procedure_withdrawn',
      'clinical.perio_exam_started',
      'clinical.perio_exam_updated',
      'clinical.perio_readings_saved',
      'clinical.perio_exam_signed',
      'clinical.perio_exam_withdrawn',
      'clinical.history_recorded',
      'clinical.history_updated',
      'clinical.history_withdrawn',
    ],
  },
  {
    key: 'reversals',
    label: 'Reversals only',
    actions: [
      'payment.voided',
      'expense.voided',
      'invoice.cancelled',
      'invoice.adjusted',
      'document.deleted',
      'clinical.note_withdrawn',
      'clinical.finding_withdrawn',
      'clinical.procedure_withdrawn',
      'clinical.perio_exam_withdrawn',
      'clinical.history_withdrawn',
    ],
  },
  {
    key: 'people',
    label: 'Staff & pay',
    actions: [
      'staff.created',
      'staff.updated',
      'staff.password_reset',
      'salary.recorded',
    ],
  },
  {
    key: 'stock',
    label: 'Stock',
    actions: [
      'inventory.item_created',
      'inventory.item_updated',
      'inventory.item_archived',
      'inventory.movement_recorded',
      'inventory.lot_tracking_enabled',
      'inventory.lot_recalled',
    ],
  },
  {
    key: 'config',
    label: 'Prices & settings',
    actions: ['treatment.created', 'treatment.updated', 'settings.updated'],
  },
];

const ACTION_LABEL: Record<string, string> = {
  'invoice.created': 'Invoice issued',
  'invoice.cancelled': 'Invoice cancelled',
  'invoice.adjusted': 'Ledger adjusted',
  'payment.recorded': 'Payment taken',
  'payment.voided': 'Payment voided',
  'expense.recorded': 'Expense recorded',
  'expense.voided': 'Expense voided',
  'staff.created': 'Account created',
  'staff.updated': 'Account changed',
  'staff.password_reset': 'Password reset',
  'salary.recorded': 'Salary paid',
  'settings.updated': 'Settings changed',
  'treatment.created': 'Treatment added',
  'treatment.updated': 'Treatment changed',
  'document.deleted': 'Document deleted',
  'patient.created': 'Patient registered',
  'patient.updated': 'Patient details changed',
  'patient.archived': 'Patient archived',
  'patient.restored': 'Patient restored',
  'clinical.note_added': 'Note added',
  'clinical.note_withdrawn': 'Note withdrawn',
  'clinical.finding_recorded': 'Finding charted',
  'clinical.finding_updated': 'Finding changed',
  'clinical.finding_withdrawn': 'Finding withdrawn',
  'clinical.procedure_logged': 'Procedure logged',
  'clinical.procedure_updated': 'Procedure changed',
  'clinical.procedure_signed': 'Procedure signed',
  'clinical.procedure_withdrawn': 'Procedure withdrawn',
  'clinical.perio_exam_started': 'Perio exam started',
  'clinical.perio_exam_updated': 'Perio exam changed',
  'clinical.perio_readings_saved': 'Perio readings saved',
  'clinical.perio_exam_signed': 'Perio exam signed',
  'clinical.perio_exam_withdrawn': 'Perio exam withdrawn',
  'clinical.history_recorded': 'Medical history added',
  'clinical.history_updated': 'Medical history changed',
  'clinical.history_withdrawn': 'Medical history withdrawn',
  'inventory.item_created': 'Stock item added',
  'inventory.item_updated': 'Stock item changed',
  'inventory.item_archived': 'Stock item archived',
  'inventory.movement_recorded': 'Stock movement',
  'inventory.lot_tracking_enabled': 'Lot tracking started',
  'inventory.lot_recalled': 'Lot recalled',
};

function iconFor(action: string) {
  if (action.startsWith('clinical') || action.startsWith('patient'))
    return <ClipboardList size={14} />;
  if (action.startsWith('payment')) return <Wallet size={14} />;
  if (action.startsWith('invoice')) return <ReceiptText size={14} />;
  if (action.startsWith('expense')) return <TrendingDown size={14} />;
  if (action.startsWith('staff') || action.startsWith('salary'))
    return <UserCog size={14} />;
  if (action.startsWith('settings')) return <Settings2 size={14} />;
  if (action.startsWith('treatment')) return <Stethoscope size={14} />;
  if (action.startsWith('document')) return <FileX size={14} />;
  if (action.startsWith('inventory')) return <Package size={14} />;
  return <History size={14} />;
}

/** A reversal is the thing the doctor is most likely to be looking for. */
const REVERSALS = new Set([
  'payment.voided',
  'expense.voided',
  'invoice.cancelled',
  'document.deleted',
  'clinical.note_withdrawn',
  'clinical.finding_withdrawn',
  'clinical.procedure_withdrawn',
  'clinical.perio_exam_withdrawn',
  'clinical.history_withdrawn',
]);

function dayLabel(iso: string) {
  // Days on the clinic's clock: an entry at 00:30 in Tirana is "today" there.
  const d = toWall(iso);
  const today = wallNow();
  today.setHours(0, 0, 0, 0);
  const that = new Date(d);
  that.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(dateLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString(
    dateLocale(),
    inClinicZone({ hour: '2-digit', minute: '2-digit' }),
  );
}

const PAGE_SIZE = 100;

export default function ActivityPage() {
  const [group, setGroup] = useState('all');
  const [days, setDays] = useState(30);
  const [data, setData] = useState<{ items: AuditEntry[]; total: number } | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);

  const from = useMemo(() => {
    if (!days) return undefined;
    return plusDays(clinicToday(), -days + 1);
  }, [days]);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    // The API filters one action at a time; a group is several, so the group
    // filter is applied here over a single fetch rather than N round trips.
    auditApi
      .list({ from, limit: 500 })
      .then((d) => {
        if (live) setData(d);
      })
      .catch(() => {
        if (live) setError('Could not load the activity trail.');
      });
    return () => {
      live = false;
    };
  }, [from]);

  useEffect(() => {
    setShown(PAGE_SIZE);
  }, [group, days]);

  const allowed = GROUPS.find((g) => g.key === group)?.actions;
  const filtered = (data?.items ?? []).filter(
    (e) => !allowed || allowed.includes(e.action),
  );
  const visible = filtered.slice(0, shown);

  const byDay: { day: string; items: AuditEntry[] }[] = [];
  for (const entry of visible) {
    const label = dayLabel(entry.createdAt);
    const last = byDay[byDay.length - 1];
    if (last && last.day === label) last.items.push(entry);
    else byDay.push({ day: label, items: [entry] });
  }

  return (
    <div className="page">
      <PageHeader
        title="Activity"
        meta={
          data
            ? `${filtered.length} recorded ${filtered.length === 1 ? 'action' : 'actions'}${
                days ? ` in the last ${days} days` : ''
              }`
            : '…'
        }
      />

      <div className="toolbar">
        <div className="tabs">
          <button
            className={`tab${group === 'all' ? ' tab--active' : ''}`}
            onClick={() => setGroup('all')}
          >
            Everything
          </button>
          {GROUPS.map((g) => (
            <button
              key={g.key}
              className={`tab${group === g.key ? ' tab--active' : ''}`}
              onClick={() => setGroup(g.key)}
            >
              {g.label}
            </button>
          ))}
        </div>
        <label className="field field--inline">
          <span>Period</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={0}>Everything</option>
          </select>
        </label>
      </div>

      <div className="card">
        {error ? (
          <p className="pad muted">{error}</p>
        ) : data === null ? (
          <LoadingRows rows={3} label="Loading" />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<History size={22} />}
            title="Nothing recorded yet"
            body="Every payment, invoice, price change and account change lands here as it happens — and cannot be edited or removed afterwards."
          />
        ) : (
          <>
            {byDay.map((bucket) => (
              <div key={bucket.day}>
                <p className="audit__day">{bucket.day}</p>
                <ul className="list">
                  {bucket.items.map((e) => (
                    <li
                      className={`row audit${REVERSALS.has(e.action) ? ' audit--reversal' : ''}`}
                      key={e.id}
                    >
                      <span className="audit__icon">{iconFor(e.action)}</span>
                      <span className="row__main">
                        <span className="row__title">{e.summary}</span>
                        <span className="row__sub">
                          {e.actor.currentName ?? e.actor.label}
                          {' · '}
                          {ROLE_LABELS[e.actor.role as Role] ?? e.actor.role}
                          {' · '}
                          {timeLabel(e.createdAt)}
                        </span>
                      </span>
                      <StatusPill
                        status={REVERSALS.has(e.action) ? 'danger' : 'neutral'}
                        label={ACTION_LABEL[e.action] ?? e.action}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {filtered.length > visible.length && (
              <div className="pad" style={{ textAlign: 'center' }}>
                <button
                  className="btn btn--ghost"
                  onClick={() => setShown((n) => n + PAGE_SIZE)}
                >
                  <Undo2 size={14} /> Show{' '}
                  {Math.min(PAGE_SIZE, filtered.length - visible.length)} more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
