import { Module } from '@nestjs/common';
import { PatientsService } from './patients.service';
import { AuthModule } from '@/modules/clinic/auth';
import { PatientsController } from './patients.controller';
import { PatientImportController } from './patient-import.controller';
import { PatientImportService } from './patient-import.service';

@Module({
  imports: [AuthModule],
  controllers: [PatientsController, PatientImportController],
  providers: [PatientsService, PatientImportService],
})
export class PatientsModule {}
