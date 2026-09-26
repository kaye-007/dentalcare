import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { MESSAGE_PURPOSES, type MessagePurpose } from '@dentalcare/shared';

/**
 * How a person sends a message from the Messages screen.
 *
 *   sms                sent now through the SMS provider
 *   whatsapp_business  sent now as an approved WhatsApp template
 *   viber              sent now through Viber Business Messages
 *   whatsapp           the staff member's own WhatsApp, opened with the text —
 *                      a HAND-OFF: the row says it was handed over, not that it
 *                      was delivered
 *   log                recorded only; nothing leaves the clinic
 */
export const SEND_CHANNELS = [
  'sms',
  'whatsapp_business',
  'viber',
  'whatsapp',
  'log',
] as const;
export type SendChannel = (typeof SEND_CHANNELS)[number];

export class SendMessageDto {
  @IsIn([...MESSAGE_PURPOSES])
  purpose!: MessagePurpose;

  @IsIn([...SEND_CHANNELS])
  channel!: SendChannel;

  /** Required for a reminder (an upcoming visit); optional for a follow-up (a past one). */
  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  /** Optional for a balance notice: one invoice's balance instead of the whole account's. */
  @IsOptional()
  @IsUUID()
  invoiceId?: string;
}

/** The conversation list's filters. */
export const CONVERSATION_FILTERS = ['all', 'whatsapp', 'viber', 'sms', 'other'] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

export class ConversationsQueryDto {
  @IsOptional()
  @IsIn([...CONVERSATION_FILTERS])
  channel?: ConversationFilter;

  @IsOptional()
  @IsIn([...MESSAGE_PURPOSES])
  purpose?: MessagePurpose;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
