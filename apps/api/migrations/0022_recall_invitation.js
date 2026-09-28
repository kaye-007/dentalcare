/**
 * 0022 — a message that invites a patient back for their check-up
 *
 * The recall list is the clinic's list of people due for a check-up with
 * nothing booked. The desk could call them from it, but in Albania most
 * patients answer WhatsApp before they answer the phone, and the messages a
 * clinic could send were a reminder of a booked visit, a follow-up after one,
 * and a note about a balance — none of them "it is time for your check-up".
 *
 * 'recall_invitation' is that message. It is sent by hand, from the desk's
 * own WhatsApp or by SMS/Viber, never by the automatic run: the existing
 * rule that automatic messages are appointment reminders stays as it is.
 */

exports.shorthands = undefined;

const UP = `
ALTER TABLE reminders DROP CONSTRAINT reminders_purpose_known;
ALTER TABLE reminders ADD CONSTRAINT reminders_purpose_known CHECK (purpose IN (
  'appointment_reminder', 'post_procedure_followup', 'unpaid_balance', 'recall_invitation'));
`;

// An invitation cannot be expressed before this migration. It becomes the
// nearest kind that can — a message about the last visit — rather than
// blocking the rollback or erasing the patient's message history.
const DOWN = `
ALTER TABLE reminders NO FORCE ROW LEVEL SECURITY;
UPDATE reminders SET purpose = 'post_procedure_followup' WHERE purpose = 'recall_invitation';
ALTER TABLE reminders FORCE ROW LEVEL SECURITY;
ALTER TABLE reminders DROP CONSTRAINT reminders_purpose_known;
ALTER TABLE reminders ADD CONSTRAINT reminders_purpose_known CHECK (purpose IN (
  'appointment_reminder', 'post_procedure_followup', 'unpaid_balance'));
`;

exports.up = (pgm) => {
  pgm.sql(UP);
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
