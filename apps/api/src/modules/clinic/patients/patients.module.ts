import { Module } from '@nestjs/common';
import { PatientsService } from './patients.service';
import { AuthModule } from '@/modules/clinic/auth';
import { PatientsController } from './patients.controller';

@Module({
  imports: [AuthModule],
  controllers: [PatientsController],
  providers: [PatientsService],
})
export class PatientsModule {}
