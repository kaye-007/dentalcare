import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { AllergiesController } from './allergies.controller';
import { ConditionsController } from './conditions.controller';
import { MedicationsController } from './medications.controller';
import { PatientHistoryController } from './patient-history.controller';
import { PatientHistoryService } from './patient-history.service';

@Module({
  imports: [AuthModule],
  controllers: [
    PatientHistoryController,
    AllergiesController,
    ConditionsController,
    MedicationsController,
  ],
  providers: [PatientHistoryService],
  exports: [PatientHistoryService],
})
export class PatientHistoryModule {}
