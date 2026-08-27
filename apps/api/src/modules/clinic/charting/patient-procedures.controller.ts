import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { ChartingService } from './charting.service';
import { CreateProcedureDto } from './dto/charting.dto';

@Controller('patients/:patientId/procedures')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientProceduresController {
  constructor(private readonly charting: ChartingService) {}

  @Get()
  @RequirePermissions('clinical:read')
  list(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.charting.listProcedures(patientId);
  }

  @Post()
  @RequirePermissions('clinical:write')
  log(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateProcedureDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.charting.logProcedure(patientId, dto, user.sub);
  }
}
