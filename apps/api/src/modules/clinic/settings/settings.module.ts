import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { ClosuresController } from './closures.controller';
import { ClosuresService } from './closures.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [AuthModule],
  controllers: [SettingsController, ClosuresController],
  providers: [SettingsService, ClosuresService],
  exports: [SettingsService],
})
export class SettingsModule {}
