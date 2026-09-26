/**
 * Money, as both the API and the clinic app handle it.
 *
 * ── Minor units ───────────────────────────────────────────────────────────
 *
 * From migration 0006 every amount is an integer number of MINOR units —
 * cents — in the clinic's currency. It was whole units before: a stored 45
 * was €45, and €37.50 could not be written down at all, nor could VAT be
 * charged on anything without rounding a line to the euro. Integers are kept
 * because floats are still wrong for money; only the unit moved.
 *
 * All five supported currencies have an ISO 4217 exponent of 2 (the lek
 * included, even though prices in lekë are rarely quoted with qindarka), so
 * one constant serves them all. A currency with a different exponent would
 * need this to become per-currency before it is added to the list.
 *
 * ── One currency per clinic ───────────────────────────────────────────────
 *
 * There is no conversion anywhere. A clinic's currency is set before it
 * records money, and the database refuses to change it afterwards (0006).
 * Every stored integer therefore means the same thing for the life of that
 * clinic's data.
 */

export const CURRENCIES = ['EUR', 'ALL', 'USD', 'GBP', 'CHF'] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

export function isCurrency(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

export const CURRENCY_NAMES: Readonly<Record<CurrencyCode, string>> = Object.freeze({
  EUR: 'Euro',
  ALL: 'Albanian lek',
  USD: 'US dollar',
  GBP: 'Pound sterling',
  CHF: 'Swiss franc',
});

/** Minor units per major unit, for every supported currency. */
export const MINOR_UNITS = 100;

/**
 * en-IE: English-language formatting with the symbol first — "€1,200.50".
 * de-DE reads "1.200,50 €", which an English UI's users read as one point two.
 */
export const MONEY_LOCALE = 'en-IE';

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: CurrencyCode, fractionDigits: 0 | 2, locale: string) {
  const key = `${locale}|${currency}|${fractionDigits}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    formatters.set(key, f);
  }
  return f;
}

/**
 * Minor units -> "€45" or "€37.50".
 *
 * A whole amount drops the ".00", which keeps a price list readable; anything
 * with cents always shows both digits, so nothing is ever rounded away on
 * screen.
 */
export function formatMoney(
  minor: number,
  currency: CurrencyCode = 'EUR',
  locale: string = MONEY_LOCALE,
): string {
  if (!Number.isFinite(minor)) return '—';
  const whole = Number.isInteger(minor) && minor % MINOR_UNITS === 0;
  return formatter(currency, whole ? 0 : 2, locale).format(minor / MINOR_UNITS);
}

/** "€", "L", "CHF" — for a field label. */
export function currencySymbol(currency: CurrencyCode, locale: string = MONEY_LOCALE): string {
  return (
    formatter(currency, 0, locale)
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value ?? currency
  );
}

/** Minor units -> what a money input should show: "45", "37.50". */
export function moneyInputValue(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(minor));
  const major = Math.floor(abs / MINOR_UNITS);
  const cents = abs % MINOR_UNITS;
  return cents === 0 ? `${sign}${major}` : `${sign}${major}.${String(cents).padStart(2, '0')}`;
}

/**
 * What someone typed into a money field -> minor units, or null.
 *
 * Exact: the digits are split and combined as integers, never multiplied as a
 * float (37.1 * 100 is 3710.0000000000005). Accepts either decimal mark,
 * because a clinic in Tirana types "37,50" and one in Dublin types "37.50":
 *
 *   "45"  "45.5"  "45,50"  "1,234.50"  "1.234,50"  "€ 45"
 *
 * With only one kind of separator, a single one followed by exactly three
 * digits is read as thousands grouping ("1,234" is 1234), which is the only
 * reading under which it is not an error. Grouping has to be real grouping —
 * one mark, groups of three — so "12.3.4,5" is refused rather than guessed
 * at. Negative amounts and more than two decimal places are refused.
 */
export function parseMoney(input: string): number | null {
  const s = input
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/^(?:€|\$|£|CHF|ALL|Lek[eë]?)/i, '')
    .replace(/(?:€|\$|£|CHF|ALL|Lek[eë]?)$/i, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimalAt = -1;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalAt = Math.max(lastDot, lastComma);
  } else {
    const at = Math.max(lastDot, lastComma);
    if (at >= 0) {
      const occurrences = s.split(s[at]!).length - 1;
      const digitsAfter = s.length - at - 1;
      if (occurrences === 1 && digitsAfter !== 3) decimalAt = at;
    }
  }

  const grouped = decimalAt >= 0 ? s.slice(0, decimalAt) : s;
  const fractionPart = decimalAt >= 0 ? s.slice(decimalAt + 1) : '';
  if (/[.,]/.test(fractionPart) || fractionPart.length > 2) return null;
  if (!isGrouped(grouped, decimalAt >= 0 ? s[decimalAt]! : null)) return null;

  const minor =
    Number(grouped.replace(/[.,]/g, '')) * MINOR_UNITS + Number(fractionPart.padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * The whole-number part is plain digits, or digits grouped in threes by one
 * mark that is not also the decimal mark: "1234", "1,234", "1.234.567".
 */
function isGrouped(integerPart: string, decimalMark: string | null): boolean {
  if (/^\d+$/.test(integerPart)) return true;
  const marks = new Set(integerPart.replace(/\d/g, ''));
  if (marks.size !== 1) return false;
  const mark = [...marks][0];
  if (mark === decimalMark) return false;
  const sep = mark === '.' ? '\\.' : ',';
  return new RegExp(`^\\d{1,3}(?:${sep}\\d{3})+$`).test(integerPart);
}
