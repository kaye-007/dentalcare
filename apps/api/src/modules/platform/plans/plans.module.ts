import { Module } from '@nestjs/common';
import { PlatformAuthModule } from '@/modules/platform/auth';
import { PlansController } from './plans.controller';

@Module({
  imports: [PlatformAuthModule],
  controllers: [PlansController],
})
export class PlansModule {}
