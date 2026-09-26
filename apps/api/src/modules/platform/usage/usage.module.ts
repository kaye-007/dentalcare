import { Module } from '@nestjs/common';
import { PlatformUsageService } from './usage.service';
import { PlatformUsageController } from './usage.controller';
import { PlatformAuthModule } from '@/modules/platform/auth';

@Module({
  imports: [PlatformAuthModule],
  controllers: [PlatformUsageController],
  providers: [PlatformUsageService],
})
export class PlatformUsageModule {}
