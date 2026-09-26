import {
  CURRENCY_NAMES,
  MONEY_LOCALE,
  currencySymbol as symbolOf,
  formatMoney as formatMinor,
  type CurrencyCode,
} from '@dentalcare/shared';

/**
 * Money formatting.
 *
 * Amounts arrive from the API as integer MINOR units — cents — in the clinic's
 * currency (migration 0006). A stored 3750 is €37.50. The arithmetic and the
 * parsing live in @dentalcare/shared so the API's activity lines and this
 * screen cannot disagree about what a number means.
 *
 * The currency is the clinic's, set once when the signed-in user loads (see
 * AuthProvider). There is no conversion anywhere: one clinic, one currency.
 */
let currency: CurrencyCode = 'EUR';

export function setCurrency(code: CurrencyCode) {
  currency = code;
}

export function currentCurrency(): CurrencyCode {
  return currency;
}

/** "€", "L", "CHF" — for field labels such as "Amount (€)". */
export function currencySymbol(): string {
  return symbolOf(currency, MONEY_LOCALE);
}

/** "Euro (EUR)" */
export function currencyLabel(code: CurrencyCode = currency): string {
  return `${CURRENCY_NAMES[code]} (${code})`;
}

/** Minor units -> "€45" or "€37.50", in the clinic's currency. */
export function formatMoney(minor: number): string {
  return formatMinor(minor, currency, MONEY_LOCALE);
}

/**
 * An API date string as a Date, reading a date-only value as a LOCAL day.
 *
 * `new Date('2026-09-17')` is midnight UTC, which formats as the 16th for
 * anyone west of Greenwich: an invoice issued today read "16 Sept" on a
 * laptop set to New York, and a shift report would name the wrong day. Values
 * that carry a time ("2026-09-17T08:30:00Z") are instants and are parsed as
 * they are.
 *
 * Use this wherever the API hands back a `date` column — issued_at,
 * expense_date, occurred_on, performed_on, business_date, birth_date.
 */
export function toDate(value: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
}

/** Titles carry no identifying information, so they are dropped before
 *  initialling — otherwise every clinician's avatar reads "D" for "Dr." and
 *  three dentists become indistinguishable. */
const HONORIFICS = /^(dr|prof|mr|mrs|ms|mx)\.?$/i;

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => !HONORIFICS.test(p));
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** "1 patient" / "2 patients" — avoids the "patient(s)" placeholder look. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : pluralForm ?? `${singular}s`}`;
}

// Soft, readable avatar tints — deterministic per name.
const AVATAR_TINTS = [
  { bg: '#e7f1ef', fg: '#0b5e57' },
  { bg: '#eef0f8', fg: '#3a4ba0' },
  { bg: '#fbeee6', fg: '#a85617' },
  { bg: '#f0eaf6', fg: '#6b3fa0' },
  { bg: '#e9f2e7', fg: '#3f7a3a' },
  { bg: '#fbe9ec', fg: '#a8324a' },
];

export function avatarTint(name: string) {
  let sum = 0;
  for (const ch of name) sum += ch.charCodeAt(0);
  return AVATAR_TINTS[sum % AVATAR_TINTS.length]!;
}
