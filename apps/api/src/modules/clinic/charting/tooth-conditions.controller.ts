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
import { UpdateToothConditionDto } from './dto/charting.dto';

@Controller('tooth-conditions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ToothConditionsController {
  constructor(private readonly charting: ChartingService) {}

  @Patch(':id')
  @RequirePermissions('clinical:write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateToothConditionDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.charting.updateCondition(id, dto, auditActor(user));
  }

  /** There is no DELETE. A wrong finding is withdrawn, with a reason. */
  @Post(':id/entered-in-error')
  @RequirePermissions('clinical:write')
  withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EnteredInErrorDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.charting.withdrawCondition(id, dto.reason, auditActor(user));
  }
}
