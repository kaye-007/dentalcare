import { IsIn, IsOptional } from 'class-validator';

/* ════════ controller ════════ */
export class SendReminderDto {
  @IsOptional()
  @IsIn(['log', 'whatsapp', 'email'])
  channel?: 'log' | 'whatsapp' | 'email';
}
