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
import { CreateOperatoryDto, UpdateOperatoryDto } from './dto/scheduling.dto';
import { OperatoriesService } from './operatories.service';

/* ═══════════════════════ controllers ═══════════════════════ */

@Controller('operatories')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OperatoriesController {
  constructor(private readonly operatories: OperatoriesService) {}

  /** Everyone schedules, so everyone reads the room list. */
  @Get()
  @RequirePermissions('appointments:read')
  list(@Query('includeInactive') includeInactive?: string) {
    return this.operatories.list(includeInactive === '1' || includeInactive === 'true');
  }

  @Post()
  @RequirePermissions('operatories:manage')
  create(@Body() dto: CreateOperatoryDto) {
    return this.operatories.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('operatories:manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOperatoryDto) {
    return this.operatories.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('operatories:manage')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.operatories.remove(id);
  }
}
