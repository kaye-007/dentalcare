import { defaultReminderTemplate, type ReminderLocale } from './reminders';

/**
 * What a clinic says to a patient, beyond "your appointment is tomorrow".
 *
 * Three kinds of message, each with built-in wording in Albanian and English:
 *
 *   appointment_reminder      sent automatically 12 or 24 hours before, or
 *                             by hand (the wording lives in reminders.ts)
 *   post_procedure_followup   the day after treatment: how are you feeling
 *   unpaid_balance            a polite note that something is still owed
 *
 * ── What a message may say ────────────────────────────────────────────────
 *
 * The rule reminders.ts sets for appointment reminders holds for all three: a
 * message is read on a lock screen, by whoever holds the phone. So none names
 * a treatment, a tooth or a diagnosis, and none carries the surname. A
 * follow-up says "after your visit", not "after your extraction"; a balance
 * notice says how much, not for what.
 *
 * ── WhatsApp ──────────────────────────────────────────────────────────────
 *
 * WhatsApp lets a business open a conversation only with a template Meta has
 * approved. Each message kind needs its own approved template, with the
 * variables in the order `whatsappVariables` lists them; a kind without one
 * is simply not offered over WhatsApp.
 */

export const MESSAGE_PURPOSES = [
  'appointment_reminder',
  'post_procedure_followup',
  'unpaid_balance',
  /** It is time for a check-up, and nothing is booked (0022). */
  'recall_invitation',
] as const;
export type MessagePurpose = (typeof MESSAGE_PURPOSES)[number];

export function isMessagePurpose(value: unknown): value is MessagePurpose {
  return (
    typeof value === 'string' && (MESSAGE_PURPOSES as readonly string[]).includes(value)
  );
}

export const MESSAGE_PURPOSE_NAMES: Readonly<Record<MessagePurpose, string>> =
  Object.freeze({
    appointment_reminder: 'Appointment reminder',
    post_procedure_followup: 'Post-procedure follow-up',
    unpaid_balance: 'Unpaid balance notice',
    recall_invitation: 'Check-up invitation',
  });

/** The short name used in TWILIO_WHATSAPP_CONTENT_SIDS ("followup.sq:HX…"). */
export const MESSAGE_PURPOSE_KEYS: Readonly<Record<MessagePurpose, string>> =
  Object.freeze({
    appointment_reminder: 'reminder',
    post_procedure_followup: 'followup',
    unpaid_balance: 'balance',
    recall_invitation: 'recall',
  });

/** Placeholders each kind can be written with. */
export const MESSAGE_PLACEHOLDERS: Readonly<Record<MessagePurpose, readonly string[]>> =
  Object.freeze({
    appointment_reminder: [
      'first_name',
      'clinic',
      'date',
      'time',
      'clinic_phone',
      'dentist',
      'clinic_address',
    ],
    post_procedure_followup: [
      'first_name',
      'clinic',
      'visit_date',
      'clinic_phone',
      'dentist',
    ],
    unpaid_balance: ['first_name', 'clinic', 'balance', 'clinic_phone'],
    recall_invitation: ['first_name', 'clinic', 'visit_date', 'clinic_phone'],
  });

export type MessageValues = Readonly<Record<string, string>>;

const BUILT_IN: Readonly<
  Record<
    Exclude<MessagePurpose, 'appointment_reminder'>,
    Record<ReminderLocale, { withPhone: string; withoutPhone: string }>
  >
> = {
  post_procedure_followup: {
    sq: {
      withPhone:
        'Përshëndetje {first_name}, shpresojmë që jeni mirë pas vizitës suaj në {clinic} më {visit_date}. Nëse keni dhimbje, ënjtje ose ndonjë pyetje, na telefononi në {clinic_phone}. Ju urojmë shërim të shpejtë!',
      withoutPhone:
        'Përshëndetje {first_name}, shpresojmë që jeni mirë pas vizitës suaj në {clinic} më {visit_date}. Nëse keni dhimbje, ënjtje ose ndonjë pyetje, ju lutemi kontaktoni klinikën. Ju urojmë shërim të shpejtë!',
    },
    en: {
      withPhone:
        'Hi {first_name}, we hope you are feeling well after your visit to {clinic} on {visit_date}. If you have any pain, swelling or questions, call us on {clinic_phone}. Wishing you a quick recovery!',
      withoutPhone:
        'Hi {first_name}, we hope you are feeling well after your visit to {clinic} on {visit_date}. If you have any pain, swelling or questions, please contact the clinic. Wishing you a quick recovery!',
    },
  },
  unpaid_balance: {
    sq: {
      withPhone:
        'Përshëndetje {first_name}, ju njoftojmë me mirësjellje se në {clinic} rezulton një detyrim i papaguar prej {balance}. Për ta shlyer ose për çdo pyetje, telefononi {clinic_phone}. Faleminderit!',
      withoutPhone:
        'Përshëndetje {first_name}, ju njoftojmë me mirësjellje se në {clinic} rezulton një detyrim i papaguar prej {balance}. Për ta shlyer ose për çdo pyetje, ju lutemi kontaktoni klinikën. Faleminderit!',
    },
    en: {
      withPhone:
        'Hi {first_name}, a friendly note that there is an outstanding balance of {balance} on your account at {clinic}. To settle it or ask about it, call {clinic_phone}. Thank you!',
      withoutPhone:
        'Hi {first_name}, a friendly note that there is an outstanding balance of {balance} on your account at {clinic}. To settle it or ask about it, please contact the clinic. Thank you!',
    },
  },
  recall_invitation: {
    sq: {
      withPhone:
        'Përshëndetje {first_name}, nga vizita juaj e fundit në {clinic} më {visit_date} ka kaluar pak kohë dhe është koha për kontrollin e radhës. Për të lënë një takim, na shkruani këtu ose telefononi {clinic_phone}.',
      withoutPhone:
        'Përshëndetje {first_name}, nga vizita juaj e fundit në {clinic} më {visit_date} ka kaluar pak kohë dhe është koha për kontrollin e radhës. Për të lënë një takim, na shkruani këtu.',
    },
    en: {
      withPhone:
        'Hi {first_name}, it has been a while since your last visit to {clinic} on {visit_date}, and it is time for your next check-up. To book, reply here or call {clinic_phone}.',
      withoutPhone:
        'Hi {first_name}, it has been a while since your last visit to {clinic} on {visit_date}, and it is time for your next check-up. To book, reply here.',
    },
  },
};

/**
 * The built-in wording for a kind of message. Two versions per language, for
 * the same reason as reminders: "call {clinic_phone}" with no phone on file
 * renders as "call ." — worse than not saying it.
 */
export function defaultMessageTemplate(
  purpose: MessagePurpose,
  locale: ReminderLocale,
  clinicHasPhone: boolean,
): string {
  if (purpose === 'appointment_reminder')
    return defaultReminderTemplate(locale, clinicHasPhone);
  const set = BUILT_IN[purpose][locale];
  return clinicHasPhone ? set.withPhone : set.withoutPhone;
}

/**
 * Fill a template with the values its kind allows. A placeholder outside that
 * list is left as written, never filled from another kind's values; spacing
 * collapses to single spaces, since every channel shows one paragraph.
 */
export function renderMessage(
  template: string,
  purpose: MessagePurpose,
  values: MessageValues,
): string {
  const allowed = MESSAGE_PLACEHOLDERS[purpose];
  return template
    .replace(/\{([a-z_]+)\}/g, (whole, name: string) =>
      allowed.includes(name) && values[name] !== undefined ? values[name]! : whole,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The variables an approved WhatsApp template is filled with, numbered as the
 * template must declare them. Reminders keep the order they shipped with.
 */
export const WHATSAPP_VARIABLES: Readonly<Record<MessagePurpose, readonly string[]>> =
  Object.freeze({
    appointment_reminder: ['first_name', 'date', 'time', 'dentist', 'clinic'],
    post_procedure_followup: ['first_name', 'clinic', 'visit_date', 'clinic_phone'],
    unpaid_balance: ['first_name', 'balance', 'clinic', 'clinic_phone'],
    recall_invitation: ['first_name', 'clinic', 'visit_date', 'clinic_phone'],
  });

export function whatsappVariables(
  purpose: MessagePurpose,
  values: MessageValues,
): Record<string, string> {
  const out: Record<string, string> = {};
  WHATSAPP_VARIABLES[purpose].forEach((name, i) => {
    // WhatsApp refuses an empty variable; a dash reads as "not given".
    out[String(i + 1)] = values[name]?.trim() || '—';
  });
  return out;
}
