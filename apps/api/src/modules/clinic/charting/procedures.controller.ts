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
import { ChartingService } from './charting.service';
import { UpdateProcedureDto } from './dto/charting.dto';

@Controller('procedures')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProceduresController {
  constructor(private readonly charting: ChartingService) {}

  @Patch(':id')
  @RequirePermissions('clinical:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProcedureDto) {
    return this.charting.updateProcedure(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('clinical:write')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.charting.deleteProcedure(id);
  }
}
