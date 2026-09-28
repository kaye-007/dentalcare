import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { LabsController, SuppliersController } from './partners.controller';
import { PartnersService } from './partners.service';

@Module({
  imports: [AuthModule],
  controllers: [LabsController, SuppliersController],
  providers: [PartnersService],
  exports: [PartnersService],
})
export class PartnersModule {}
