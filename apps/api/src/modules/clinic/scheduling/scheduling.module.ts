import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
import { OperatoriesController } from './operatories.controller';
import { OperatoriesService } from './operatories.service';

@Module({
  imports: [AuthModule],
  controllers: [OperatoriesController, AvailabilityController],
  providers: [OperatoriesService, AvailabilityService],
  exports: [OperatoriesService, AvailabilityService],
})
export class SchedulingModule {}
