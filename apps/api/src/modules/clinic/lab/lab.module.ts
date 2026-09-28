import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { LabOrdersController } from './lab.controller';
import { LabService } from './lab.service';

@Module({
  imports: [AuthModule],
  controllers: [LabOrdersController],
  providers: [LabService],
})
export class LabModule {}
