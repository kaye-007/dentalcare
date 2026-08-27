import { Body, Controller, Delete, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { ChartingService } from './charting.service';
import { UpdateToothConditionDto } from './dto/charting.dto';

@Controller('tooth-conditions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ToothConditionsController {
  constructor(private readonly charting: ChartingService) {}

  @Patch(':id')
  @RequirePermissions('clinical:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateToothConditionDto) {
    return this.charting.updateCondition(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('clinical:write')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.charting.deleteCondition(id);
  }
}
