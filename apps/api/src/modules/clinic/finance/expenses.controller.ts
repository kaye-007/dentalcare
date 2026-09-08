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
import { CreateExpenseDto, VoidDto } from './dto/finance.dto';
import { FinanceService } from './finance.service';

@Controller('expenses')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ExpensesController {
  constructor(private readonly finance: FinanceService) {}

  @Get()
  @RequirePermissions('expenses:read')
  list(@Query('category') category?: string) {
    return this.finance.listExpenses({ category });
  }

  @Post()
  @RequirePermissions('expenses:write')
  create(@Body() dto: CreateExpenseDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.finance.createExpense(dto, auditActor(user));
  }

  @Post(':id/void')
  @RequirePermissions('expenses:void')
  voidExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.finance.voidExpense(id, dto.reason, auditActor(user));
  }
}
