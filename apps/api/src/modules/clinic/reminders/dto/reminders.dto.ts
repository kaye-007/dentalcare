import { IsIn, IsOptional } from 'class-validator';

/**
 * How a person sends a reminder from the appointment screen.
 *
 *   sms       sent now through the configured SMS provider
 *   whatsapp  the staff member's own WhatsApp, opened with the message
 *   email     the staff member's own mail app, likewise
 *   log       recorded on the internal log only
 */
export const MANUAL_CHANNELS = ['sms', 'log', 'whatsapp', 'email'] as const;
export type ManualChannel = (typeof MANUAL_CHANNELS)[number];

/* ════════ controller ════════ */
export class SendReminderDto {
  @IsOptional()
  @IsIn([...MANUAL_CHANNELS])
  channel?: ManualChannel;
}
