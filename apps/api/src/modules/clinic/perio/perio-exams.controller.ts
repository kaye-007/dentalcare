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
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { EnteredInErrorDto } from '@/shared/dto/entered-in-error.dto';
import { CreatePerioExamDto, SaveMeasurementsDto } from './dto/perio.dto';
import { PerioService } from './perio.service';

@Controller('perio-exams')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PerioExamsController {
  constructor(private readonly perio: PerioService) {}

  @Get(':id')
  @RequirePermissions('clinical:read')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.perio.getExam(id);
  }

  @Patch(':id')
  @RequirePermissions('clinical:write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePerioExamDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.perio.updateExam(id, dto, auditActor(user));
  }

  /** Bulk upsert — a full-mouth chart is one request. */
  @Post(':id/measurements')
  @RequirePermissions('clinical:write')
  save(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveMeasurementsDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.perio.saveMeasurements(id, dto, auditActor(user));
  }

  @Post(':id/sign')
  @RequirePermissions('clinical:sign')
  sign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AccessTokenPayload) {
    return this.perio.signExam(id, auditActor(user));
  }

  /** There is no DELETE. A wrong exam is withdrawn, with a reason. */
  @Post(':id/entered-in-error')
  @RequirePermissions('clinical:write')
  withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EnteredInErrorDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.perio.withdrawExam(id, dto.reason, auditActor(user));
  }
}
