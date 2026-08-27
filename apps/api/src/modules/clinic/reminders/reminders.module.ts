import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { ChannelRegistry, LogChannel } from './channels/channels';
import { ReminderSchedulerService } from './reminder-scheduler.service';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';

@Module({
  imports: [AuthModule],
  controllers: [RemindersController],
  providers: [RemindersService, ReminderSchedulerService, LogChannel, ChannelRegistry],
})
export class RemindersModule {}
