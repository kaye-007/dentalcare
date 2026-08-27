import { Module } from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import { AppointmentEvents } from './appointment-events';
import { AuthModule } from '@/modules/clinic/auth';
import { AppointmentsController } from './appointments.controller';

@Module({
  imports: [AuthModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService, AppointmentEvents],
  exports: [AppointmentsService, AppointmentEvents],
})
export class AppointmentsModule {}
