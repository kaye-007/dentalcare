import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppGraphClient } from './graph-client';
import { WhatsAppRemindersService } from './whatsapp-reminders.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppTokenBox } from './token-box';

@Module({
  imports: [AuthModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, WhatsAppRemindersService, WhatsAppGraphClient, WhatsAppTokenBox],
})
export class WhatsAppModule {}
