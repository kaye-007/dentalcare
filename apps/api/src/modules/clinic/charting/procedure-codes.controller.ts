import {
  Body,
  Controller,
  Delete,
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
import { ChartingService } from './charting.service';
import { CreateProcedureCodeDto, UpdateProcedureCodeDto } from './dto/charting.dto';

@Controller('procedure-codes')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProcedureCodesController {
  constructor(private readonly charting: ChartingService) {}

  @Get()
  @RequirePermissions('clinical:read')
  list(
    @Query('system') system?: string,
    @Query('q') q?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.charting.listCodes({
      system: system && ['CDT', 'ICD10', 'custom'].includes(system) ? system : undefined,
      q,
      includeInactive: includeInactive === '1' || includeInactive === 'true',
    });
  }

  @Post()
  @RequirePermissions('treatments:manage')
  create(@Body() dto: CreateProcedureCodeDto) {
    return this.charting.createCode(dto);
  }

  @Patch(':id')
  @RequirePermissions('treatments:manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProcedureCodeDto) {
    return this.charting.updateCode(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('treatments:manage')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.charting.deleteCode(id);
  }
}
