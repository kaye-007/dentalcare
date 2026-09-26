import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { UpdatePlanItemDto } from './dto/treatment-plans.dto';
import { TreatmentPlansService } from './treatment-plans.service';

@Controller('treatment-plan-items')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PlanItemsController {
  constructor(private readonly plans: TreatmentPlansService) {}

  @Patch(':id')
  @RequirePermissions('plans:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanItemDto) {
    return this.plans.updateItem(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('plans:write')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.plans.removeItem(id);
  }
}
