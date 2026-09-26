import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
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
import { ClosuresService } from './closures.service';
import { CreateClosureDto } from './dto/closures.dto';

/** Holidays, closures and time off. See ClosuresService for the two permissions. */
@Controller('closures')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ClosuresController {
  constructor(private readonly closures: ClosuresService) {}

  @Get()
  @RequirePermissions('appointments:read')
  list(@Query('from') from?: string, @Query('to') to?: string) {
    return this.closures.list(from, to);
  }

  @Post()
  @RequirePermissions('availability:manage')
  create(@Body() dto: CreateClosureDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.closures.create(dto, auditActor(user));
  }

  @Delete(':id')
  @RequirePermissions('availability:manage')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AccessTokenPayload) {
    return this.closures.remove(id, auditActor(user));
  }
}
