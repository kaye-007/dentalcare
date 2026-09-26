import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { EnteredInErrorDto } from '@/shared/dto/entered-in-error.dto';
import { ChartingService } from './charting.service';
import { UpdateProcedureDto } from './dto/charting.dto';

/**
 * One logged procedure. There is no DELETE: a procedure is withdrawn as
 * entered in error, and once signed it cannot be edited at all.
 */
@Controller('procedures')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProceduresController {
  constructor(private readonly charting: ChartingService) {}

  @Patch(':id')
  @RequirePermissions('clinical:write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProcedureDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.charting.updateProcedure(id, dto, auditActor(user));
  }

  @Post(':id/sign')
  @RequirePermissions('clinical:sign')
  sign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AccessTokenPayload) {
    return this.charting.signProcedure(id, auditActor(user));
  }

  /**
   * `clinical:write` at the route. Whether THIS caller may withdraw THIS
   * procedure depends on whether it is signed, which only the row knows —
   * see withdrawEntry.
   */
  @Post(':id/entered-in-error')
  @RequirePermissions('clinical:write')
  withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EnteredInErrorDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.charting.withdrawProcedure(id, dto.reason, auditActor(user));
  }
}
