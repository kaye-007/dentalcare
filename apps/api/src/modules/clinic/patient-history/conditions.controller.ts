import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { EnteredInErrorDto } from '@/shared/dto/entered-in-error.dto';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { LogPatientAccess } from '@/core/audit/patient-access';
import { CreateConditionDto, UpdateConditionDto } from './dto/patient-history.dto';
import { PatientHistoryService } from './patient-history.service';

@Controller('patients/:patientId/conditions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ConditionsController {
  constructor(private readonly history: PatientHistoryService) {}

  @Get()
  @RequirePermissions('clinical:read')
  @LogPatientAccess('history')
  list(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.history.listConditions(patientId);
  }

  @Post()
  @RequirePermissions('history:write')
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateConditionDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.history.createCondition(patientId, dto, auditActor(user));
  }

  @Patch(':id')
  @RequirePermissions('history:write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConditionDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.history.updateCondition(id, dto, auditActor(user));
  }

  /** There is no DELETE. A resolved condition is resolved; a wrong one is withdrawn. */
  @Post(':id/entered-in-error')
  @RequirePermissions('history:write')
  withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EnteredInErrorDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.history.withdrawCondition(id, dto.reason, auditActor(user));
  }
}
