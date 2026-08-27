import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { SendReminderDto } from './dto/reminders.dto';
import { RemindersService } from './reminders.service';

// Bare @Controller() on purpose: the two routes below live under different
// resource roots ('reminders' and 'appointments/:id/reminders'), so each
// carries its full path rather than sharing a prefix.
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get('reminders')
  @RequirePermissions('reminders:read')
  list(@Query('appointmentId') appointmentId?: string) {
    return this.reminders.list(appointmentId);
  }

  @Post('appointments/:id/reminders')
  @RequirePermissions('reminders:send')
  sendManual(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendReminderDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.reminders.sendManual(id, user.sub, body?.channel ?? 'log');
  }
}
