import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { LogChannel } from './channels/channels';
import { ChannelRegistry } from './channels/registry';
import { TwilioSmsChannel } from './channels/twilio';
import { VonageViberChannel } from './channels/viber';
import { TwilioWhatsAppChannel } from './channels/whatsapp';
import { ReminderDeliveryController } from './reminder-delivery.controller';
import { ReminderSchedulerService } from './reminder-scheduler.service';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';
import { MessagesController, PatientMessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  imports: [AuthModule],
  controllers: [
    RemindersController,
    ReminderDeliveryController,
    MessagesController,
    PatientMessagesController,
  ],
  providers: [
    RemindersService,
    MessagesService,
    ReminderSchedulerService,
    LogChannel,
    TwilioSmsChannel,
    TwilioWhatsAppChannel,
    VonageViberChannel,
    ChannelRegistry,
  ],
})
export class RemindersModule {}
