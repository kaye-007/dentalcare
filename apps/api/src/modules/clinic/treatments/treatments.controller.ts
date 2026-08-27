import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { CreateTreatmentDto, UpdateTreatmentDto } from './dto/treatments.dto';
import { TreatmentsService } from './treatments.service';

/* ── controller ──────────────────────────────────────────── */
@Controller('treatments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TreatmentsController {
  constructor(private readonly treatments: TreatmentsService) {}

  @Get()
  @RequirePermissions('treatments:read')
  list(@Query('q') q?: string, @Query('status') status?: string) {
    return this.treatments.list({ q, status });
  }

  @Post()
  @RequirePermissions('treatments:manage')
  create(@Body() dto: CreateTreatmentDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.treatments.create(dto, auditActor(user));
  }

  @Patch(':id')
  @RequirePermissions('treatments:manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTreatmentDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.treatments.update(id, dto, auditActor(user));
  }
}
