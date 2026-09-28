/**
 * WhatsApp appointment reminders from the clinic's own number (0017).
 *
 * Shared by the API, which fills the approved Meta template, and the clinic
 * app, which shows the preview — so the preview is built from the same values
 * the patient receives.
 *
 * The content is deliberately general: who, which clinic, when, and the
 * clinic's phone. Never a treatment, a diagnosis, a balance or anything else
 * from the record.
 */

import { toE164 } from './reminders';

/** The variables a reminder template may use, as Meta's named parameters. */
export const WHATSAPP_REMINDER_VARIABLES = [
  'patient_name',
  'clinic_name',
  'appointment_date',
  'appointment_time',
  'clinic_phone',
] as const;
export type WhatsAppVariable = (typeof WHATSAPP_REMINDER_VARIABLES)[number];
export type WhatsAppValues = Record<WhatsAppVariable, string>;

export const WHATSAPP_DEFAULT_PREVIEWS = {
  sq:
    'Përshëndetje {{patient_name}}, kjo është një kujtesë nga {{clinic_name}}. Ju keni një takim nesër, më ' +
    '{{appointment_date}}, në orën {{appointment_time}}. Ju lutemi na kontaktoni nëse dëshironi të bëni ndryshime.',
  en:
    'Hi {{patient_name}}, this is a reminder from {{clinic_name}}. You have an appointment tomorrow, ' +
    '{{appointment_date}}, at {{appointment_time}}. Please contact us if you need to make any changes.',
} as const;

/** Meta's rules for a template name: lowercase letters, digits and underscores. */
export const META_TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
/** A WhatsApp template language: "sq", "en", "en_US". */
export const META_LANGUAGE_CODE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

const VARIABLE = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

/** The variable names a text uses, in order of first appearance. */
export function templateVariables(body: string): string[] {
  const seen: string[] = [];
  for (const m of body.matchAll(VARIABLE)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
}

/** Variables a text uses that a reminder cannot fill. */
export function unknownWhatsAppVariables(body: string): string[] {
  return templateVariables(body).filter(
    (v) => !(WHATSAPP_REMINDER_VARIABLES as readonly string[]).includes(v),
  );
}

/** The text with its variables filled; an unknown one is left as written. */
export function renderWhatsAppPreview(
  body: string,
  values: Partial<WhatsAppValues>,
): string {
  return body.replace(
    VARIABLE,
    (whole, name: string) => values[name as WhatsAppVariable] ?? whole,
  );
}

const MONTHS = {
  sq: [
    'janar',
    'shkurt',
    'mars',
    'prill',
    'maj',
    'qershor',
    'korrik',
    'gusht',
    'shtator',
    'tetor',
    'nëntor',
    'dhjetor',
  ],
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
} as const;

/** The language family a template code belongs to, for dates: "en_US" -> "en". Albanian otherwise. */
export function dateLanguage(languageCode: string): 'sq' | 'en' {
  return languageCode.toLowerCase().startsWith('en') ? 'en' : 'sq';
}

/** Wall-clock parts of an instant in the clinic's zone. */
function zonedParts(
  at: Date,
  timeZone: string,
): { month: number; day: number; hour: string; minute: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour!,
    minute: parts.minute!,
  };
}

/** "27 shtator" / "27 September" and "09:00", in the clinic's zone. Written out, not left to the runtime's locale data. */
export function formatReminderWhen(
  startsAt: Date,
  timeZone: string,
  languageCode: string,
): { date: string; time: string } {
  const p = zonedParts(startsAt, timeZone);
  const date = `${p.day} ${MONTHS[dateLanguage(languageCode)][p.month - 1]}`;
  return { date, time: `${p.hour}:${p.minute}` };
}

/** Everything a reminder says, from what the clinic and the appointment hold. */
export function whatsAppReminderValues(input: {
  patientFirstName: string;
  clinicName: string;
  clinicPhone: string | null;
  startsAt: Date;
  timeZone: string;
  languageCode: string;
}): WhatsAppValues {
  const when = formatReminderWhen(input.startsAt, input.timeZone, input.languageCode);
  return {
    patient_name: input.patientFirstName.trim(),
    clinic_name: input.clinicName.trim(),
    appointment_date: when.date,
    appointment_time: when.time,
    clinic_phone: (input.clinicPhone ?? '').trim(),
  };
}

/** Sample data for the template editor's live preview. */
export const WHATSAPP_SAMPLE = {
  patientFirstName: 'Ardit',
  clinicName: 'Dental Clinic Tirana',
  clinicPhone: '+355 69 123 4567',
} as const;

/* ── who can be reminded ─────────────────────────────────────────────────── */

/**
 * Why an appointment cannot be reminded, most decisive first. The first that
 * applies is the one shown.
 */
export const WHATSAPP_EXCLUSIONS = [
  'appointment_cancelled',
  'opted_out',
  'no_consent',
  'phone_missing',
  'phone_invalid',
  'already_sent',
  'not_connected',
  'no_template',
] as const;
export type WhatsAppExclusion = (typeof WHATSAPP_EXCLUSIONS)[number];

export const WHATSAPP_EXCLUSION_LABELS: Record<WhatsAppExclusion, string> = {
  appointment_cancelled: 'Appointment cancelled',
  opted_out: 'Opted out',
  no_consent: 'No WhatsApp consent',
  phone_missing: 'Phone number missing',
  phone_invalid: 'Invalid phone number',
  already_sent: 'Reminder already sent',
  not_connected: 'WhatsApp not connected',
  no_template: 'No approved template',
};

/** The number a reminder goes to: the WhatsApp number on file, else the patient's phone. */
export function whatsAppRecipient(
  patient: { whatsappPhone: string | null; phone: string | null },
  countryCode: string,
): { phone: string | null; problem: 'phone_missing' | 'phone_invalid' | null } {
  const written = patient.whatsappPhone?.trim() || patient.phone?.trim() || '';
  if (!written) return { phone: null, problem: 'phone_missing' };
  const e164 = toE164(written, countryCode);
  return e164
    ? { phone: e164, problem: null }
    : { phone: null, problem: 'phone_invalid' };
}

/** The first reason an appointment is excluded, or null when it can be reminded. */
export function whatsAppExclusion(input: {
  appointmentStatus: string;
  optedOut: boolean;
  optIn: boolean;
  phoneProblem: 'phone_missing' | 'phone_invalid' | null;
  alreadySent: boolean;
  connected: boolean;
  templateReady: boolean;
}): WhatsAppExclusion | null {
  if (input.appointmentStatus === 'cancelled') return 'appointment_cancelled';
  if (input.optedOut) return 'opted_out';
  if (!input.optIn) return 'no_consent';
  if (input.phoneProblem) return input.phoneProblem;
  if (input.alreadySent) return 'already_sent';
  if (!input.connected) return 'not_connected';
  if (!input.templateReady) return 'no_template';
  return null;
}

/* ── what happened to a send ─────────────────────────────────────────────── */

export const WHATSAPP_SEND_STATUSES = [
  'queued',
  'sending',
  'accepted',
  'sent',
  'failed',
  'skipped',
  'already_sent',
] as const;
export type WhatsAppSendStatus = (typeof WHATSAPP_SEND_STATUSES)[number];

export const WHATSAPP_SEND_STATUS_LABELS: Record<WhatsAppSendStatus, string> = {
  queued: 'Queued',
  sending: 'Sending',
  accepted: 'Accepted by API',
  sent: 'Sent',
  failed: 'Failed',
  skipped: 'Skipped',
  already_sent: 'Already sent',
};

/** A send that holds the appointment's one reminder: nothing else may be sent for it. */
export function isLiveSend(status: WhatsAppSendStatus): boolean {
  return (
    status === 'queued' ||
    status === 'sending' ||
    status === 'accepted' ||
    status === 'sent'
  );
}

export const WHATSAPP_OPT_IN_SOURCES = [
  'in_person',
  'paper_form',
  'phone',
  'message',
] as const;
export type WhatsAppOptInSource = (typeof WHATSAPP_OPT_IN_SOURCES)[number];
export const WHATSAPP_OPT_IN_SOURCE_LABELS: Record<WhatsAppOptInSource, string> = {
  in_person: 'In person at the clinic',
  paper_form: 'Signed form',
  phone: 'On the phone',
  message: 'By message',
};

/** The most reminders one click sends; more is a second batch. */
export const WHATSAPP_BATCH_LIMIT = 200;
