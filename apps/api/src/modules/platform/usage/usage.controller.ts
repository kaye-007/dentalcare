import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { PlatformUsageService } from './usage.service';
import { PlatformJwtGuard } from '@/modules/platform/auth';

@Controller('platform/usage')
@UseGuards(PlatformJwtGuard)
export class PlatformUsageController {
  constructor(private readonly usage: PlatformUsageService) {}

  @Get()
  fleet() {
    return this.usage.fleet();
  }

  @Get(':id')
  forTenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.usage.forTenant(id);
  }
}
