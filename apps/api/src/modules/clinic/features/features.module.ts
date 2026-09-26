import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { FeaturesController } from './features.controller';
import { FeaturesService } from './features.service';

@Module({
  imports: [AuthModule],
  controllers: [FeaturesController],
  providers: [FeaturesService],
})
export class FeaturesModule {}
