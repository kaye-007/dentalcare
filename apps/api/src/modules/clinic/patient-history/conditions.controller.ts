import {
  Body,
  Controller,
  Delete,
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
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CreateConditionDto, UpdateConditionDto } from './dto/patient-history.dto';
import { PatientHistoryService } from './patient-history.service';

@Controller('patients/:patientId/conditions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ConditionsController {
  constructor(private readonly history: PatientHistoryService) {}

  @Get()
  @RequirePermissions('clinical:read')
  list(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.history.listConditions(patientId);
  }

  @Post()
  @RequirePermissions('clinical:write')
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateConditionDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.history.createCondition(patientId, dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions('clinical:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateConditionDto) {
    return this.history.updateCondition(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('clinical:write')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.history.deleteCondition(id);
  }
}
