import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { ChartController } from './chart.controller';
import { ChartingService } from './charting.service';
import { PatientProceduresController } from './patient-procedures.controller';
import { ProcedureCodesController } from './procedure-codes.controller';
import { ProceduresController } from './procedures.controller';
import { ToothConditionsController } from './tooth-conditions.controller';

@Module({
  imports: [AuthModule],
  controllers: [
    ChartController,
    ToothConditionsController,
    ProcedureCodesController,
    PatientProceduresController,
    ProceduresController,
  ],
  providers: [ChartingService],
  exports: [ChartingService],
})
export class ChartingModule {}
