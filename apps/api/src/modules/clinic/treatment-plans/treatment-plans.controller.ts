import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CreatePlanItemDto, TransitionPlanDto, UpdatePlanDto } from './dto/treatment-plans.dto';
import { TreatmentPlansService } from './treatment-plans.service';

@Controller('treatment-plans')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TreatmentPlansController {
  constructor(private readonly plans: TreatmentPlansService) {}

  @Get(':id')
  @RequirePermissions('clinical:read')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.plans.getById(id);
  }

  @Patch(':id')
  @RequirePermissions('clinical:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanDto) {
    return this.plans.update(id, dto);
  }

  @Post(':id/status')
  @RequirePermissions('clinical:write')
  transition(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionPlanDto) {
    return this.plans.transition(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('clinical:write')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.plans.remove(id);
  }

  @Post(':id/items')
  @RequirePermissions('clinical:write')
  addItem(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePlanItemDto) {
    return this.plans.addItem(id, dto);
  }
}
