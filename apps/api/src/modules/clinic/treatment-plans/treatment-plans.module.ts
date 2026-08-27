import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { PatientPlansController } from './patient-plans.controller';
import { PlanItemsController } from './plan-items.controller';
import { TreatmentPlansController } from './treatment-plans.controller';
import { TreatmentPlansService } from './treatment-plans.service';

@Module({
  imports: [AuthModule],
  controllers: [PatientPlansController, TreatmentPlansController, PlanItemsController],
  providers: [TreatmentPlansService],
  exports: [TreatmentPlansService],
})
export class TreatmentPlansModule {}
