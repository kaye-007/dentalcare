import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { can, normalizeRole } from '@dentalcare/shared';
import { AvailabilityService } from './availability.service';
import { CreateAvailabilityDto, UpdateAvailabilityDto } from './dto/scheduling.dto';

@Controller('availability')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @RequirePermissions('appointments:read')
  list(@Query('staffId') staffId?: string) {
    return this.availability.list(staffId);
  }

  /**
   * A dentist may set their own hours; changing someone else's needs
   * `availability:manage`.
   */
  @Post()
  @RequirePermissions('appointments:read')
  create(@Body() dto: CreateAvailabilityDto, @CurrentUser() user: AccessTokenPayload) {
    this.assertMayEdit(user, dto.staffId);
    return this.availability.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('appointments:read')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAvailabilityDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    const owner = await this.availability.ownerOf(id);
    if (!owner) throw new NotFoundException('Availability entry not found');
    this.assertMayEdit(user, owner);
    return this.availability.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('appointments:read')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    const owner = await this.availability.ownerOf(id);
    if (!owner) throw new NotFoundException('Availability entry not found');
    this.assertMayEdit(user, owner);
    return this.availability.remove(id);
  }

  private assertMayEdit(user: AccessTokenPayload, staffId: string) {
    if (user.sub === staffId) return;
    const role = normalizeRole(user.role);
    if (!role || !can(role, 'availability:manage')) {
      throw new ForbiddenException(
        "You can only change your own working hours. Ask an administrator to change someone else's.",
      );
    }
  }
}
