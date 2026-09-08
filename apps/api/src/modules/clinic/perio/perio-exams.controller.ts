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
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
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
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePerioExamDto) {
    return this.perio.updateExam(id, dto);
  }

  /** Bulk upsert — a full-mouth chart is one request. */
  @Post(':id/measurements')
  @RequirePermissions('clinical:write')
  save(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveMeasurementsDto) {
    return this.perio.saveMeasurements(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('clinical:write')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.perio.deleteExam(id);
  }
}
