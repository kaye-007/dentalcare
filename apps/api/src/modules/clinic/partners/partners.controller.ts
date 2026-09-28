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
import { CreatePartnerDto, UpdatePartnerDto } from './dto/partners.dto';
import { PartnersService } from './partners.service';

/** The dental laboratories the clinic sends work to. */
@Controller('labs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LabsController {
  constructor(private readonly partners: PartnersService) {}

  @Get()
  @RequirePermissions('lab:read')
  list(@Query('all') all?: string) {
    return this.partners.list('lab', all === '1');
  }

  @Post()
  @RequirePermissions('lab:write')
  create(@Body() dto: CreatePartnerDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.partners.create('lab', dto, auditActor(user));
  }

  @Patch(':id')
  @RequirePermissions('lab:write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartnerDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.partners.update('lab', id, dto, auditActor(user));
  }
}

/**
 * Who the clinic buys materials from. The same permissions as recording
 * stock: the person who notices the gloves are nearly gone is the one who
 * rings the supplier.
 */
@Controller('suppliers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SuppliersController {
  constructor(private readonly partners: PartnersService) {}

  @Get()
  @RequirePermissions('inventory:read')
  list(@Query('all') all?: string) {
    return this.partners.list('supplier', all === '1');
  }

  @Post()
  @RequirePermissions('inventory:write')
  create(@Body() dto: CreatePartnerDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.partners.create('supplier', dto, auditActor(user));
  }

  @Patch(':id')
  @RequirePermissions('inventory:write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartnerDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.partners.update('supplier', id, dto, auditActor(user));
  }
}
