import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  imports: [AuthModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
