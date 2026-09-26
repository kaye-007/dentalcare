import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { SetFeatureDto } from './dto/features.dto';
import { FeaturesService } from './features.service';

/**
 * Settings → Features. Every role reads it — the app hides what a clinic does
 * not have — and only the administrator switches anything.
 */
@Controller('features')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  @Get()
  @RequirePermissions('settings:read')
  list() {
    return this.features.list();
  }

  @Patch(':key')
  @RequirePermissions('settings:manage')
  set(@Param('key') key: string, @Body() dto: SetFeatureDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.features.setEnabled(key, dto.enabled, auditActor(user));
  }
}
