import { Module } from '@nestjs/common';
import { PlatformAuthModule } from '@/modules/platform/auth';
import { PlatformActivityController } from './activity.controller';
import { PlatformActivityService } from './activity.service';

@Module({
  imports: [PlatformAuthModule],
  controllers: [PlatformActivityController],
  providers: [PlatformActivityService],
})
export class PlatformActivityModule {}
