import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import {
  CreateInventoryItemDto,
  RecallLotDto,
  SetSupplierDto,
  UpdateInventoryItemDto,
} from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

/**
 * Stock.
 *
 * Permissions split along one line: recording what happened versus deciding
 * what is tracked.
 *
 *   inventory:read    the list, the alerts, the history, the lots
 *   inventory:manage  add an item, rename it, archive it, move a reorder
 *                     level, switch lot tracking, recall a lot
 *
 * Recording a movement lives on the nested controller and needs
 * `inventory:write`, which reception holds. See the note in the shared
 * permission matrix for why the front desk has to be able to do that.
 *
 * Who received a lot names patients, so it needs `patients:read` as well.
 */
@Controller('inventory')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermissions('inventory:read')
  list(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('low') low?: string,
    @Query('expiring') expiring?: string,
  ) {
    return this.inventory.list({
      q,
      status,
      category,
      lowOnly: low === '1',
      expiringOnly: expiring === '1',
    });
  }

  /** What needs ordering, expires soon, or was recalled. Drives the dashboard too. */
  @Get('alerts')
  @RequirePermissions('inventory:read')
  alerts() {
    return this.inventory.alerts();
  }

  @Get('categories')
  @RequirePermissions('inventory:read')
  categories() {
    return this.inventory.categories();
  }

  /** Everything that moved recently, across every item. */
  @Get('movements')
  @RequirePermissions('inventory:read')
  recentMovements(@Query('limit') limit?: string) {
    return this.inventory.recentMovements(Number(limit) || 100);
  }

  /** Every patient a lot was used on — the list a recall needs. */
  @Get('lots/:lotId/usage')
  @RequirePermissions('inventory:read', 'patients:read')
  lotUsage(@Param('lotId', ParseUUIDPipe) lotId: string) {
    return this.inventory.lotUsage(lotId);
  }

  /** Permanent. The lot can then only be written off or counted. */
  @Post('lots/:lotId/recall')
  @RequirePermissions('inventory:manage')
  recallLot(
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() dto: RecallLotDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.inventory.recallLot(lotId, dto.reason, auditActor(user));
  }

  @Get(':id')
  @RequirePermissions('inventory:read')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.getById(id);
  }

  @Get(':id/lots')
  @RequirePermissions('inventory:read')
  lots(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.lots(id);
  }

  @Post()
  @RequirePermissions('inventory:manage')
  create(@Body() dto: CreateInventoryItemDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.inventory.create(dto, auditActor(user));
  }

  /**
   * Everything about an item except its quantity — that moves only through a
   * movement, so the history stays a complete account of the shelf.
   */
  @Patch(':id')
  @RequirePermissions('inventory:manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInventoryItemDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.inventory.update(id, dto, auditActor(user));
  }

  /** Who it is reordered from. `inventory:write`: it changes no warning. */
  @Put(':id/supplier')
  @RequirePermissions('inventory:write')
  setSupplier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetSupplierDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.inventory.setSupplier(id, dto.supplierId, auditActor(user));
  }
}
