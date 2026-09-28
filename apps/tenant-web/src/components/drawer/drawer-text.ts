import { formatMoney, type CurrencyCode, type VarianceBand } from '@dentalcare/shared';
import type { DrawerSessionStatus } from '../../lib/api';
import { inClinicZone } from '../../lib/clinic-time';
import { currentCurrency } from '../../lib/format';

type PillKind = 'ok' | 'info' | 'warn' | 'danger' | 'neutral' | 'done';

/** "Balanced", "Over €5", "Short 1,200 L" — words, so colour is never the only signal. */
export function varianceText(variance: number, currency: CurrencyCode): string {
  if (variance === 0) return 'Balanced';
  return `${variance > 0 ? 'Over' : 'Short'} ${formatMoney(Math.abs(variance), currency)}`;
}

/**
 * The same, for a list that mixes currencies: "EUR balanced", "Short €100",
 * "Short 8,500 L". The amount already names its currency; only "balanced"
 * needs the code added.
 */
export function varianceLabel(variance: number, currency: CurrencyCode): string {
  // The code is only worth saying where a second currency could be meant.
  if (variance === 0)
    return currency === currentCurrency() ? 'Balanced' : `${currency} balanced`;
  return varianceText(variance, currency);
}

/** A currency tab: its code once, then the amount — "ALL · 10,000 L", "EUR · €100". */
export function currencyTabLabel(amount: number, currency: CurrencyCode): string {
  const text = formatMoney(amount, currency);
  return text.includes(currency) ? text : `${currency} · ${text}`;
}

export const BAND_PILL: Record<VarianceBand, { kind: PillKind; label: string }> = {
  exact: { kind: 'done', label: 'Within tolerance' },
  note: { kind: 'warn', label: 'Needs a note' },
  approval: { kind: 'danger', label: 'Needs approval' },
};

export const SESSION_STATUS: Record<
  DrawerSessionStatus,
  { kind: PillKind; label: string }
> = {
  open: { kind: 'info', label: 'Open' },
  counting: { kind: 'warn', label: 'Counting' },
  pending_approval: { kind: 'danger', label: 'Waiting for approval' },
  closed: { kind: 'done', label: 'Closed' },
  force_closed: { kind: 'neutral', label: 'Force-closed' },
};

export const EVENT_LABEL: Record<string, string> = {
  open: 'Float in',
  cash_sale: 'Cash payment',
  cash_sale_voided: 'Cash payment voided',
  payout: 'Paid out',
  drop: 'To the safe',
  add_float: 'Cash added',
  no_sale: 'Opened without a sale',
  post_close_void: 'Voided after close',
};

/** "08:45" on the clinic's clock, whatever zone this computer is in. */
export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(
    'en-GB',
    inClinicZone({ hour: '2-digit', minute: '2-digit' }),
  );
}

export function dateOf(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
