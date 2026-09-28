import { toE164 } from '@dentalcare/shared';
import type { LabOrder, LabStatus } from './api';
import { wallNow } from './clinic-time';
import { dateLocale } from './strings';

/**
 * How lab work is talked about on screen. The rules of its life live on the
 * API (lab-status.ts); this is only the words for them.
 */

export const LAB_STATUS_LABEL: Record<LabStatus, string> = {
  preparing: 'Preparing',
  sent: 'At the lab',
  received: 'Back from the lab',
  fitted: 'Fitted',
  cancelled: 'Cancelled',
};

/** The one step forward a screen offers, and the word on its button. */
const NEXT: Partial<Record<LabStatus, { to: LabStatus; button: string; said: string }>> =
  {
    preparing: { to: 'sent', button: 'Sent', said: 'is at the lab' },
    sent: { to: 'received', button: 'Received', said: 'is back from the lab' },
    received: { to: 'fitted', button: 'Fitted', said: 'is fitted' },
  };

export function nextLabStep(status: LabStatus) {
  return NEXT[status] ?? null;
}

/** The step before, which is what Undo returns to. */
export const PREVIOUS: Partial<Record<LabStatus, LabStatus>> = {
  sent: 'preparing',
  received: 'sent',
  fitted: 'received',
};

/** "36" or "34, 35, 36" — FDI, as the chart writes them. */
export function teethLabel(teeth: number[]) {
  return teeth.join(', ');
}

/** "E-max crown · 36" */
export function workLabel(o: Pick<LabOrder, 'work' | 'teeth'>) {
  return o.teeth.length
    ? `${o.work} · ${o.teeth.length > 1 ? 'teeth' : 'tooth'} ${teethLabel(o.teeth)}`
    : o.work;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The clinic's today, "2026-09-28". */
export function clinicToday() {
  const w = wallNow();
  return `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())}`;
}
const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000,
  );

/**
 * What the date means for this job, in a few words, and whether it needs an
 * eye: "3 days late", "Due tomorrow", "Back since Tue".
 */
export function labWhen(o: LabOrder): {
  text: string;
  tone: 'danger' | 'warn' | 'quiet';
} {
  const today = clinicToday();
  if (o.status === 'received' && o.receivedAt) {
    return {
      text: `Back since ${new Date(o.receivedAt).toLocaleDateString(dateLocale(), {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })} · ready to fit`,
      tone: 'warn',
    };
  }
  if (o.status === 'fitted' && o.fittedAt) {
    return {
      text: `Fitted ${new Date(o.fittedAt).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })}`,
      tone: 'quiet',
    };
  }
  if (o.status === 'cancelled')
    return { text: o.cancelReason ?? 'Cancelled', tone: 'quiet' };
  if (!o.dueOn) return { text: 'No due date', tone: 'quiet' };
  const d = daysBetween(today, o.dueOn);
  if (d < 0) return { text: `${-d} ${d === -1 ? 'day' : 'days'} late`, tone: 'danger' };
  if (d === 0) return { text: 'Due today', tone: 'warn' };
  if (d === 1) return { text: 'Due tomorrow', tone: 'quiet' };
  return {
    text: `Due ${new Date(`${o.dueOn}T12:00:00`).toLocaleDateString(dateLocale(), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    })}`,
    tone: 'quiet',
  };
}

/**
 * A WhatsApp link to the lab with the question already written, in Albanian —
 * the language the clinic and its lab work in. The desk can change it before
 * sending; nothing is sent from here.
 */
export function labWhatsApp(o: LabOrder, countryCode = '355') {
  const to = toE164(o.labPhone, countryCode);
  if (!to) return null;
  const teeth = o.teeth.length ? ` (${teethLabel(o.teeth)})` : '';
  const text = `Përshëndetje, për pacientin ${o.patientName}: ${o.work}${teeth}. A është gati?`;
  return `https://wa.me/${to.slice(1)}?text=${encodeURIComponent(text)}`;
}

/** A plain tel: link, digits and a leading plus only. */
export function telLink(phone: string | null) {
  return phone ? `tel:${phone.replace(/[^\d+]/g, '')}` : null;
}
