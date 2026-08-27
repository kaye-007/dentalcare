import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { ChartingService } from './charting.service';
import { CreateToothConditionDto } from './dto/charting.dto';

/* ═══════════════════════ controllers ═══════════════════════ */

@Controller('patients/:patientId/chart')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ChartController {
  constructor(private readonly charting: ChartingService) {}

  @Get()
  @RequirePermissions('clinical:read')
  chart(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.charting.chart(patientId);
  }

  @Post('conditions')
  @RequirePermissions('clinical:write')
  add(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateToothConditionDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.charting.addCondition(patientId, dto, user.sub);
  }
}
