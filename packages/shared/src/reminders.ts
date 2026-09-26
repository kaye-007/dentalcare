/**
 * Appointment reminders: the words, the number and the cost.
 *
 * Shared because the API sends the message and the clinic app previews it in
 * Settings, and a preview that renders differently from what the patient
 * receives is worse than no preview.
 *
 * ── What a reminder says ──────────────────────────────────────────────────
 *
 * An SMS is read on a lock screen, by whoever is holding the phone. So the
 * built-in wording carries the patient's first name, the clinic, and when —
 * and deliberately not the treatment ("Root canal, tooth 36") or the surname.
 * A clinic can write its own message, but only from the same placeholders, so
 * a template cannot reach for anything the default leaves out.
 *
 * ── Times ─────────────────────────────────────────────────────────────────
 *
 * Formatted in the clinic's own time zone. The API runs on servers whose
 * clock is UTC, so "10:30" rendered with the server's zone told a patient in
 * Tirana to come at 08:30.
 */

export const REMINDER_LOCALES = ['en', 'sq'] as const;
export type ReminderLocale = (typeof REMINDER_LOCALES)[number];

export function isReminderLocale(value: unknown): value is ReminderLocale {
  return typeof value === 'string' && (REMINDER_LOCALES as readonly string[]).includes(value);
}

export const REMINDER_LOCALE_NAMES: Readonly<Record<ReminderLocale, string>> = Object.freeze({
  en: 'English',
  sq: 'Shqip',
});

/**
 * Everything a reminder may say. Nothing clinical is on this list, on purpose.
 * The dentist's name and the clinic's address tell a patient where to go and
 * whom they are seeing; neither says why.
 */
export const REMINDER_PLACEHOLDERS = [
  'first_name',
  'clinic',
  'date',
  'time',
  'clinic_phone',
  'dentist',
  'clinic_address',
] as const;
export type ReminderPlaceholder = (typeof REMINDER_PLACEHOLDERS)[number];
export type ReminderValues = Record<ReminderPlaceholder, string>;

/**
 * How an automatic reminder reaches the patient.
 *
 *   sms                SMS through the deployment's SMS provider
 *   whatsapp_business  WhatsApp Business through the provider, using a
 *                      template Meta has approved. The clinic's own wording
 *                      cannot be used there: WhatsApp only lets a business
 *                      start a conversation with pre-approved text.
 *   viber              Viber Business Messages
 *
 * Distinct from the manual 'whatsapp' hand-off on the appointment screen,
 * which opens the staff member's own app and sends nothing from the server.
 */
export const REMINDER_CHANNELS = ['sms', 'whatsapp_business', 'viber'] as const;
export type ReminderChannelId = (typeof REMINDER_CHANNELS)[number];

export const REMINDER_CHANNEL_NAMES: Readonly<Record<ReminderChannelId, string>> = Object.freeze({
  sms: 'SMS',
  whatsapp_business: 'WhatsApp',
  viber: 'Viber',
});

export function isReminderChannel(value: unknown): value is ReminderChannelId {
  return typeof value === 'string' && (REMINDER_CHANNELS as readonly string[]).includes(value);
}

/** When an automatic reminder goes out: 12 or 24 hours before. */
export const REMINDER_HOURS_OPTIONS = [12, 24] as const;
export type ReminderHours = (typeof REMINDER_HOURS_OPTIONS)[number];

const DEFAULTS: Readonly<Record<ReminderLocale, { withPhone: string; withoutPhone: string }>> = {
  en: {
    withPhone:
      'Hi {first_name}, this is a reminder of your appointment at {clinic} on {date} at {time}. To reschedule, call {clinic_phone}.',
    withoutPhone:
      'Hi {first_name}, this is a reminder of your appointment at {clinic} on {date} at {time}. Please contact the clinic if you need to reschedule.',
  },
  sq: {
    withPhone:
      'Përshëndetje {first_name}, ju kujtojmë takimin tuaj në {clinic} më {date} në orën {time}. Për ta ndryshuar, telefononi {clinic_phone}.',
    withoutPhone:
      'Përshëndetje {first_name}, ju kujtojmë takimin tuaj në {clinic} më {date} në orën {time}. Nëse duhet ta ndryshoni, kontaktoni klinikën.',
  },
};

/**
 * The built-in message. Two versions per language, because "call {clinic_phone}"
 * with no phone on file renders as "call ." — a sentence that is worse than
 * saying nothing.
 */
export function defaultReminderTemplate(locale: ReminderLocale, clinicHasPhone: boolean): string {
  const set = DEFAULTS[locale];
  return clinicHasPhone ? set.withPhone : set.withoutPhone;
}

/** Placeholders in a template that no reminder can fill, e.g. "{reason}". */
export function unknownPlaceholders(template: string): string[] {
  const known = REMINDER_PLACEHOLDERS as readonly string[];
  const unknown = new Set<string>();
  for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
    if (!known.includes(match[1]!)) unknown.add(`{${match[1]}}`);
  }
  return [...unknown];
}

/**
 * Fill a template. Whitespace is collapsed to single spaces: an SMS is one
 * paragraph, and a stray line break costs a character in every message sent.
 */
export function renderReminder(template: string, values: ReminderValues): string {
  const known = REMINDER_PLACEHOLDERS as readonly string[];
  return template
    .replace(/\{([a-z_]+)\}/g, (whole, name: string) =>
      known.includes(name) ? values[name as ReminderPlaceholder] : whole,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

const LOCALE_TAGS: Readonly<Record<ReminderLocale, string>> = { en: 'en-GB', sq: 'sq-AL' };

/** An IANA zone this runtime can format in, e.g. "Europe/Tirane". */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** "Tuesday 15 September" and "10:30", in the clinic's zone and language. */
export function formatAppointmentTime(
  startsAt: Date,
  timeZone: string,
  locale: ReminderLocale,
): { date: string; time: string } {
  const tag = LOCALE_TAGS[locale];
  const date = new Intl.DateTimeFormat(tag, {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(startsAt);
  const time = new Intl.DateTimeFormat(tag, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(startsAt);
  return { date, time };
}

/**
 * A phone number as typed at the front desk, as E.164 — "+355691234567" — or
 * null when it cannot be one.
 *
 * `countryCode` is the clinic's own calling code without "+", used for numbers
 * written the local way:
 *
 *   "069 123 4567"      national, trunk 0     -> +355 69 123 4567
 *   "69 123 4567"       national, no trunk    -> +355 69 123 4567
 *   "+355 69 123 4567"  international         -> as written
 *   "00355691234567"    international, 00     -> +355 69 123 4567
 *
 * Anything with letters in it ("ext. 12", "ask for Ana") is refused rather
 * than guessed at: an SMS to a wrong number is a message about someone's
 * health delivered to a stranger.
 */
export function toE164(raw: string | null | undefined, countryCode: string): string | null {
  if (!raw) return null;
  const written = raw.trim();
  if (written === '' || /[a-z]/i.test(written)) return null;

  const compact = written.replace(/[\s().\-/]/g, '');
  let international: string;
  if (compact.startsWith('+')) {
    international = compact.slice(1);
  } else if (compact.startsWith('00')) {
    international = compact.slice(2);
  } else if (compact.startsWith('0')) {
    international = countryCode + compact.slice(1);
  } else if (compact.startsWith(countryCode) && compact.length - countryCode.length >= 8) {
    international = compact;
  } else {
    international = countryCode + compact;
  }

  // E.164: up to 15 digits, never starting with 0. Eight is the shortest
  // subscriber number worth sending a reminder to.
  return /^[1-9]\d{7,14}$/.test(international) ? `+${international}` : null;
}

/* ── what a message costs ────────────────────────────────────────────── */

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€\f';

/**
 * How many SMS parts a message is billed as.
 *
 * Plain Latin text fits 160 characters in one part. One character outside the
 * GSM alphabet — an Albanian "ë" is enough — switches the whole message to
 * UCS-2, where a part holds 70. Clinics writing in Albanian should see that
 * before the invoice does.
 */
export function smsSegments(text: string): {
  encoding: 'gsm7' | 'ucs2';
  characters: number;
  segments: number;
} {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXTENDED.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    return { encoding: 'gsm7', characters: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  }
  const units = text.length; // UTF-16 code units, which is what UCS-2 counts
  return { encoding: 'ucs2', characters: units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}
