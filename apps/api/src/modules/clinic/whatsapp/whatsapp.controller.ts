import {
  Body,
  Controller,
  Delete,
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
import { Idempotent } from '@/core/idempotency/idempotency.interceptor';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppRemindersService } from './whatsapp-reminders.service';
import {
  ConnectionDto,
  HistoryQueryDto,
  ReminderDayQueryDto,
  SendRemindersDto,
  TemplateDto,
  TestConnectionDto,
  UpdateTemplateDto,
} from './dto/whatsapp.dto';

/**
 * WhatsApp appointment reminders from the clinic's own number (0017).
 *
 * The clinic is always the signed-in user's: no route takes a clinic id.
 * Connecting and templates are settings; seeing and sending reminders are
 * the front desk's.
 */
@Controller('whatsapp')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class WhatsAppController {
  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly reminders: WhatsAppRemindersService,
  ) {}

  /* ── connection ── */

  @Get('connection')
  @RequirePermissions('reminders:read')
  connection() {
    return this.whatsapp.getConnection();
  }

  @Post('connection/test')
  @RequirePermissions('settings:manage')
  test(@Body() dto: TestConnectionDto) {
    return this.whatsapp.test(dto);
  }

  @Put('connection')
  @RequirePermissions('settings:manage')
  save(@Body() dto: ConnectionDto, @CurrentUser() user: AccessTokenPayload) {
    return this.whatsapp.save(dto, auditActor(user));
  }

  @Delete('connection')
  @RequirePermissions('settings:manage')
  disconnect(@CurrentUser() user: AccessTokenPayload) {
    return this.whatsapp.disconnect(auditActor(user));
  }

  /* ── templates ── */

  @Get('templates')
  @RequirePermissions('reminders:read')
  templates() {
    return this.whatsapp.listTemplates();
  }

  @Post('templates')
  @RequirePermissions('settings:manage')
  createTemplate(@Body() dto: TemplateDto, @CurrentUser() user: AccessTokenPayload) {
    return this.whatsapp.createTemplate(dto, auditActor(user));
  }

  @Patch('templates/:id')
  @RequirePermissions('settings:manage')
  updateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.whatsapp.updateTemplate(id, dto, auditActor(user));
  }

  @Delete('templates/:id')
  @RequirePermissions('settings:manage')
  deleteTemplate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessTokenPayload) {
    return this.whatsapp.deleteTemplate(id, auditActor(user));
  }

  @Post('templates/:id/check')
  @RequirePermissions('settings:manage')
  checkTemplate(@Param('id', ParseUUIDPipe) id: string) {
    return this.whatsapp.checkTemplate(id);
  }

  /* ── reminders ── */

  @Get('reminders')
  @RequirePermissions('reminders:read')
  day(@Query() q: ReminderDayQueryDto) {
    return this.reminders.day(q.date);
  }

  @Post('reminders/send')
  @Idempotent()
  @RequirePermissions('reminders:send')
  send(@Body() dto: SendRemindersDto, @CurrentUser() user: AccessTokenPayload) {
    return this.reminders.send(dto, auditActor(user));
  }

  @Get('history')
  @RequirePermissions('reminders:read')
  history(@Query() q: HistoryQueryDto) {
    return this.reminders.history(q);
  }
}
