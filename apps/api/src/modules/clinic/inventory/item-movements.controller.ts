import {
  Body,
  Controller,
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
import { RecordMovementDto } from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

/**
 * Movements against one item.
 *
 * Separate from InventoryController because the permission is different:
 * recording that ten gloves were used is the front desk's job all day
 * (`inventory:write`), while deciding that gloves are tracked at all is the
 * doctor's (`inventory:manage`).
 *
 * There is no DELETE and no PATCH here, and there is no route that could
 * provide one: migration 0002 withholds UPDATE and DELETE on stock_movements
 * from the runtime role entirely. A movement entered by mistake is corrected
 * by an opposing movement, and both stay on the record — the same shape
 * payments use.
 */
@Controller('inventory/:itemId/movements')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ItemMovementsController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermissions('inventory:read')
  list(@Param('itemId', ParseUUIDPipe) itemId: string, @Query('limit') limit?: string) {
    return this.inventory.movementsFor(itemId, Number(limit) || 100);
  }

  @Post()
  @RequirePermissions('inventory:write')
  record(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: RecordMovementDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.inventory.recordMovement(itemId, dto, auditActor(user));
  }
}
