import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { PatientPerioController } from './patient-perio.controller';
import { PerioExamsController } from './perio-exams.controller';
import { PerioService } from './perio.service';

@Module({
  imports: [AuthModule],
  controllers: [PatientPerioController, PerioExamsController],
  providers: [PerioService],
  exports: [PerioService],
})
export class PerioModule {}
