/**
 * Patient import: which columns a file can map to, and what makes a row good.
 *
 * Shared so the preview a receptionist reads before committing is produced by
 * the same rules the API applies when it commits. The API re-runs every rule
 * on every row it receives — the browser's verdict is a preview, never trust.
 */
import { MINOR_UNITS, parseMoney } from './money';
import { toE164 } from './reminders';

export const IMPORT_FIELDS = [
  'firstName',
  'lastName',
  'phone',
  'email',
  'birthDate',
  'nationalId',
  'gender',
  'address',
  'city',
  'medicalConditions',
  'balance',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Readonly<Record<ImportField, string>> = Object.freeze({
  firstName: 'First name',
  lastName: 'Last name',
  phone: 'Phone',
  email: 'Email',
  birthDate: 'Date of birth',
  nationalId: 'National ID',
  gender: 'Gender',
  address: 'Address',
  city: 'City',
  medicalConditions: 'Medical conditions',
  balance: 'Opening balance',
});

/** Rows one request may carry. The client sends a larger file in batches. */
export const IMPORT_BATCH_LIMIT = 500;

/** How dates in the file are written. 03/04/1990 is ambiguous; a person decides. */
export const IMPORT_DATE_FORMATS = ['DMY', 'MDY', 'YMD'] as const;
export type ImportDateFormat = (typeof IMPORT_DATE_FORMATS)[number];

/** Header spellings seen in real exports, English and Albanian, lower-cased. */
const HEADER_ALIASES: Readonly<Record<ImportField, readonly string[]>> = {
  firstName: ['first name', 'firstname', 'first', 'given name', 'name', 'emri', 'emër'],
  lastName: ['last name', 'lastname', 'surname', 'family name', 'mbiemri', 'mbiemër'],
  phone: ['phone', 'mobile', 'telephone', 'tel', 'cell', 'phone number', 'telefon', 'telefoni', 'celular', 'nr. telefoni'],
  email: ['email', 'e-mail', 'mail', 'email address'],
  birthDate: ['date of birth', 'dob', 'birth date', 'birthdate', 'birthday', 'datelindja', 'data e lindjes', 'ditëlindja'],
  nationalId: ['national id', 'nid', 'id number', 'personal number', 'personal id', 'numri personal', 'nr. personal', 'id'],
  gender: ['gender', 'sex', 'gjinia'],
  address: ['address', 'street', 'adresa', 'adresë'],
  city: ['city', 'town', 'qyteti', 'qytet'],
  medicalConditions: ['medical conditions', 'conditions', 'medical history', 'diagnoses', 'sëmundje', 'semundje', 'gjendja shëndetësore'],
  balance: ['balance', 'opening balance', 'amount owed', 'debt', 'outstanding', 'balanca', 'detyrim', 'borxh'],
};

/** A first guess at which column is which, by header name. Unmatched columns map to nothing. */
export function guessMapping(headers: readonly string[]): (ImportField | null)[] {
  const taken = new Set<ImportField>();
  return headers.map((h) => {
    const key = h.trim().toLowerCase().replace(/[_\s]+/g, ' ');
    for (const field of IMPORT_FIELDS) {
      if (!taken.has(field) && HEADER_ALIASES[field].includes(key)) {
        taken.add(field);
        return field;
      }
    }
    return null;
  });
}

export type RawImportRow = Partial<Record<ImportField, string>>;

export interface ImportedPatient {
  firstName: string;
  lastName: string;
  phone: string | null;
  /** The phone as E.164, for duplicate matching and reminders. */
  phoneE164: string | null;
  email: string | null;
  birthDate: string | null;
  nationalId: string | null;
  gender: 'male' | 'female' | 'other' | null;
  address: string | null;
  city: string | null;
  conditions: string[];
  /** Minor units. Positive: the patient owes the clinic; negative: a credit. */
  balance: number;
}

export interface ImportIssue {
  field: ImportField;
  message: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A national identifier compared the way the database compares it. */
export function normalizeNationalId(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * "03/04/1990" -> "1990-04-03" under DMY. Refuses dates that do not exist
 * (31/02), are in the future, or are before 1900 — each of which, in a legacy
 * export, is a sign the column was mapped wrong rather than a real birthday.
 */
export function parseImportDate(raw: string, format: ImportDateFormat, today = new Date()): string | null {
  const parts = raw.trim().split(/[./\-\s]+/).filter(Boolean);
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const [a, b, c] = parts.map(Number) as [number, number, number];
  const [written, m, d] = format === 'YMD' ? [a, b, c] : format === 'DMY' ? [c, b, a] : [c, a, b];
  const y = written < 100 ? written + (written > today.getFullYear() % 100 ? 1900 : 2000) : written;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (y < 1900 || date.getTime() > today.getTime()) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseGender(raw: string): ImportedPatient['gender'] | undefined {
  const v = raw.trim().toLowerCase();
  if (v === '') return null;
  if (['m', 'male', 'man', 'mashkull', 'burrë'].includes(v)) return 'male';
  if (['f', 'female', 'woman', 'femër', 'femer', 'grua'].includes(v)) return 'female';
  if (['o', 'other', 'tjetër', 'tjeter', 'x'].includes(v)) return 'other';
  return undefined;
}

/** "120.50", "-30", "1.200,00 L" -> minor units, or null when unreadable. */
function parseBalance(raw: string): number | null {
  const v = raw.trim();
  if (v === '') return 0;
  const negative = /^-|^\(.*\)$|-$/.test(v);
  const minor = parseMoney(v.replace(/^[-(]|[-)]$/g, ''));
  if (minor === null) return null;
  return negative ? -minor : minor;
}

/** Largest opening balance one row may carry: a typo guard, not a business rule. */
const MAX_BALANCE = 1_000_000 * MINOR_UNITS;

/** Check and normalise one row. Errors mean the row is not imported. */
export function normalizeImportRow(
  raw: RawImportRow,
  opts: { dateFormat: ImportDateFormat; countryCode: string },
): { value: ImportedPatient; errors: ImportIssue[] } {
  const errors: ImportIssue[] = [];
  const text = (f: ImportField, max: number) => {
    const v = (raw[f] ?? '').trim().replace(/\s+/g, ' ');
    if (v.length > max) errors.push({ field: f, message: `Longer than ${max} characters` });
    return v === '' ? null : v.slice(0, max);
  };

  const firstName = text('firstName', 100);
  const lastName = text('lastName', 100);
  if (!firstName) errors.push({ field: 'firstName', message: 'First name is missing' });
  if (!lastName) errors.push({ field: 'lastName', message: 'Last name is missing' });

  const phone = text('phone', 40);
  const phoneE164 = phone ? toE164(phone, opts.countryCode) : null;
  if (phone && !phoneE164) errors.push({ field: 'phone', message: `"${phone}" is not a usable phone number` });

  const email = text('email', 254);
  if (email && !EMAIL.test(email)) errors.push({ field: 'email', message: `"${email}" is not a valid email address` });

  const birthRaw = text('birthDate', 40);
  const birthDate = birthRaw ? parseImportDate(birthRaw, opts.dateFormat) : null;
  if (birthRaw && !birthDate) {
    errors.push({ field: 'birthDate', message: `"${birthRaw}" is not a date of birth in the chosen format` });
  }

  const idRaw = text('nationalId', 40);
  const nationalId = idRaw ? normalizeNationalId(idRaw) : null;
  if (nationalId && !/^[A-Z0-9-]{4,20}$/.test(nationalId)) {
    errors.push({ field: 'nationalId', message: `"${idRaw}" is not a national ID number` });
  }

  const gender = parseGender(raw.gender ?? '');
  if (gender === undefined) errors.push({ field: 'gender', message: `"${raw.gender}" is not a gender this system records` });

  const balance = parseBalance(raw.balance ?? '');
  if (balance === null) errors.push({ field: 'balance', message: `"${raw.balance}" is not an amount` });
  else if (Math.abs(balance) > MAX_BALANCE) errors.push({ field: 'balance', message: 'The balance is implausibly large' });

  const conditions = (raw.medicalConditions ?? '')
    .split(/[;|\n]+/)
    .map((c) => c.trim().replace(/\s+/g, ' '))
    .filter((c) => c !== '')
    .slice(0, 30)
    .map((c) => c.slice(0, 200));

  return {
    value: {
      firstName: firstName ?? '',
      lastName: lastName ?? '',
      phone,
      phoneE164,
      email: email?.toLowerCase() ?? null,
      birthDate,
      nationalId,
      gender: gender ?? null,
      address: text('address', 200),
      city: text('city', 80),
      conditions,
      balance: balance ?? 0,
    },
    errors,
  };
}

/**
 * Rows that repeat an earlier row of the same file, by national ID or phone.
 * Returns row index -> index of the first row it repeats.
 */
export function duplicatesWithinFile(
  rows: readonly Pick<ImportedPatient, 'phoneE164' | 'nationalId'>[],
): Map<number, number> {
  const byId = new Map<string, number>();
  const byPhone = new Map<string, number>();
  const out = new Map<number, number>();
  rows.forEach((r, i) => {
    const first =
      (r.nationalId ? byId.get(r.nationalId) : undefined) ??
      (r.phoneE164 ? byPhone.get(r.phoneE164) : undefined);
    if (first !== undefined) {
      out.set(i, first);
      return;
    }
    if (r.nationalId) byId.set(r.nationalId, i);
    if (r.phoneE164) byPhone.set(r.phoneE164, i);
  });
  return out;
}
