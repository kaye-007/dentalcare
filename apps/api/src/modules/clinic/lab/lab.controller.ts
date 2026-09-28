import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { CreateLabOrderDto, MoveLabOrderDto, UpdateLabOrderDto } from './dto/lab.dto';
import { LabService } from './lab.service';

/**
 * Lab work: crowns, bridges and appliances made by a dental laboratory.
 *
 *   lab:read   the list, a patient's lab work, the dashboard numbers
 *   lab:write  order it, change it, move it along, cancel it
 *
 * Every holder of lab:read also reads patients, whose names the list shows.
 */
@Controller('lab-orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LabOrdersController {
  constructor(private readonly lab: LabService) {}

  @Get()
  @RequirePermissions('lab:read')
  list(@Query('scope') scope?: string, @Query('patientId') patientId?: string) {
    return this.lab.list({ scope, patientId: patientId || undefined });
  }

  /** Late, back to fit, due in the next two days. Drives "Needs attention". */
  @Get('summary')
  @RequirePermissions('lab:read')
  summary() {
    return this.lab.summary();
  }

  @Post()
  @RequirePermissions('lab:write')
  create(@Body() dto: CreateLabOrderDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.lab.create(dto, auditActor(user));
  }

  @Patch(':id')
  @RequirePermissions('lab:write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLabOrderDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.lab.update(id, dto, auditActor(user));
  }

  @Post(':id/status')
  @RequirePermissions('lab:write')
  move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveLabOrderDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.lab.move(id, dto, auditActor(user));
  }
}
