import {
  Archive,
  Ban,
  Building2,
  CircleCheck,
  CirclePlay,
  Download,
  Globe,
  Hourglass,
  KeyRound,
  Layers,
  PauseCircle,
  PlayCircle,
  ReceiptText,
  RotateCcw,
  ShieldOff,
  Tag,
  Trash2,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { formatEuro, METHOD_LABELS, type PaymentMethod } from './api';
import { fmtDate } from './format';

export type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral';

export interface Described {
  /** What happened, as a verb phrase: "Suspended", "Recorded a payment". */
  verb: string;
  /** One line of what made this entry different from the last of its kind. */
  detail?: string;
  icon: LucideIcon;
  tone: Tone;
}

/** The fields an audit row carries, whichever endpoint it came from. */
interface AuditLike {
  action: string;
  metadata: Record<string, unknown>;
  invoice_number?: string | null;
  plan_name?: string | null;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * An audit row in words.
 *
 * The trail stores what happened as a code and a bag of metadata; this is
 * the one place that turns it back into a sentence, so the clinic page, the
 * overview and the activity screen can never describe the same event two
 * different ways. An action it does not know still renders — as its code —
 * rather than disappearing from the trail.
 */
export function describe(a: AuditLike, plans?: Map<string, string>): Described {
  const m = a.metadata ?? {};
  const planName = (id: unknown) => (typeof id === 'string' ? plans?.get(id) : undefined);

  switch (a.action) {
    case 'tenant.created': {
      const trial = num(m.trialDays);
      return {
        verb: 'Created clinic',
        detail: [
          str(m.ownerEmail) && `Owner ${str(m.ownerEmail)}`,
          trial ? `${trial}-day trial` : 'Paid from day one',
        ]
          .filter(Boolean)
          .join(' · '),
        icon: Building2,
        tone: 'ok',
      };
    }
    case 'tenant.suspended':
      return {
        verb: 'Suspended',
        detail: 'Nobody at the clinic can sign in',
        icon: PauseCircle,
        tone: 'warn',
      };
    case 'tenant.reactivated':
      return { verb: 'Reactivated', icon: PlayCircle, tone: 'ok' };
    case 'tenant.archived':
      return { verb: 'Archived', icon: Archive, tone: 'neutral' };
    case 'tenant.deleted':
      return {
        verb: 'Deleted',
        detail: str(m.reason) && `“${str(m.reason)}”`,
        icon: Trash2,
        tone: 'danger',
      };
    case 'tenant.restored':
      return {
        verb: 'Restored',
        detail: 'Back as suspended',
        icon: RotateCcw,
        tone: 'ok',
      };
    case 'tenant.exported':
      return {
        verb: 'Exported data of',
        detail:
          num(m.rows) !== undefined
            ? `${num(m.rows)!.toLocaleString('en-GB')} records`
            : undefined,
        icon: Download,
        tone: 'info',
      };
    case 'tenant.plan_changed': {
      const from = planName(m.from) ?? (m.from ? 'another plan' : 'no plan');
      const to = planName(m.to) ?? (m.to ? 'another plan' : 'no plan');
      return {
        verb: 'Changed the plan of',
        detail: `${from} → ${to}`,
        icon: Layers,
        tone: 'info',
      };
    }
    case 'tenant.subdomain_changed':
      return {
        verb: 'Moved',
        detail: str(m.from) && str(m.to) ? `${str(m.from)} → ${str(m.to)}` : undefined,
        icon: Globe,
        tone: 'info',
      };
    case 'tenant.trial_set': {
      const days = num(m.days);
      const to = str(m.to);
      return {
        verb: days === 0 ? 'Ended the trial of' : 'Set the trial of',
        detail:
          days === 0
            ? 'Read-only from now'
            : to
              ? `Runs until ${fmtDate(to)}`
              : undefined,
        icon: Hourglass,
        tone: days === 0 ? 'warn' : 'info',
      };
    }
    case 'tenant.converted_to_paid':
      return { verb: 'Converted to paid', icon: CircleCheck, tone: 'ok' };
    case 'tenant.user_password_reset':
      return {
        verb: 'Reset a password at',
        detail: str(m.email),
        icon: KeyRound,
        tone: 'warn',
      };
    case 'tenant.user_mfa_reset':
      return {
        verb: 'Reset two-step sign-in at',
        detail: str(m.email),
        icon: ShieldOff,
        tone: 'warn',
      };
    case 'platform.billing.run': {
      const issued = num(m.issued) ?? 0;
      const considered = num(m.considered) ?? 0;
      return {
        verb: 'Ran billing',
        detail:
          issued === 0
            ? `Nothing new to issue · ${considered} clinic${considered === 1 ? '' : 's'} checked`
            : `${issued} invoice${issued === 1 ? '' : 's'} issued · ${considered} clinic${considered === 1 ? '' : 's'} checked`,
        icon: CirclePlay,
        tone: 'info',
      };
    }
    case 'platform.billing.paid': {
      const method = str(m.method) as PaymentMethod | undefined;
      return {
        verb: 'Recorded a payment',
        detail: [
          a.invoice_number,
          num(m.amount) !== undefined ? formatEuro(num(m.amount)!) : undefined,
          method ? (METHOD_LABELS[method] ?? method) : undefined,
          str(m.reference),
        ]
          .filter(Boolean)
          .join(' · '),
        icon: Wallet,
        tone: 'ok',
      };
    }
    case 'platform.billing.void':
      return {
        verb: 'Voided an invoice',
        detail: [a.invoice_number, str(m.reason) && `“${str(m.reason)}”`]
          .filter(Boolean)
          .join(' · '),
        icon: Ban,
        tone: 'neutral',
      };
    case 'plan.created':
      return {
        verb: 'Created plan',
        detail:
          num(m.priceMonthly) !== undefined
            ? `${formatEuro(num(m.priceMonthly)!)} a month`
            : undefined,
        icon: Tag,
        tone: 'ok',
      };
    case 'plan.updated': {
      const price = m.priceMonthly as { from?: number; to?: number } | undefined;
      const name = m.name as { from?: string; to?: string } | undefined;
      const parts: string[] = [];
      if (name?.from && name.to && name.from !== name.to)
        parts.push(`${name.from} → ${name.to}`);
      if (
        price &&
        price.from !== price.to &&
        price.from !== undefined &&
        price.to !== undefined
      ) {
        parts.push(`${formatEuro(price.from)} → ${formatEuro(price.to)} a month`);
      }
      return {
        verb: 'Edited plan',
        detail: parts.join(' · ') || undefined,
        icon: Tag,
        tone: 'info',
      };
    }
    case 'plan.retired':
      return {
        verb: 'Retired plan',
        detail: 'No new clinic can be put on it',
        icon: Archive,
        tone: 'neutral',
      };
    case 'plan.restored':
      return { verb: 'Brought back plan', icon: RotateCcw, tone: 'ok' };
    case 'role.collapsed':
      return { verb: 'Migrated roles at', icon: ReceiptText, tone: 'neutral' };
    default:
      return { verb: a.action, icon: ReceiptText, tone: 'neutral' };
  }
}

/** What the entry was about, for the title: a clinic, a plan, or nothing named. */
export function subjectOf(e: {
  entity_type: string;
  tenant_name?: string | null;
  plan_name?: string | null;
  metadata: Record<string, unknown>;
}): string | null {
  if (e.tenant_name) return e.tenant_name;
  if (e.entity_type === 'plan') return e.plan_name ?? str(e.metadata.name) ?? null;
  if (e.entity_type === 'tenant')
    return str(e.metadata.name) ?? str(e.metadata.subdomain) ?? null;
  return null;
}

/** "Today", "Yesterday", or the date — the day headers of a feed. */
export function dayHeading(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}
