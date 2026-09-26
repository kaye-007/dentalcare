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
import { LogPatientAccess } from '@/core/audit/patient-access';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { ConversationsQueryDto, SendMessageDto } from './dto/messages.dto';
import { MessagesService } from './messages.service';

/** Every message sent to patients, one conversation per patient. */
@Controller('messages')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get('conversations')
  @RequirePermissions('reminders:read')
  conversations(@Query() query: ConversationsQueryDto) {
    return this.messages.conversations(query);
  }
}

/** One patient's conversation, and sending them a message. */
@Controller('patients/:patientId/messages')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientMessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  @RequirePermissions('reminders:read')
  @LogPatientAccess('messages')
  thread(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.messages.thread(patientId);
  }

  @Post()
  @RequirePermissions('reminders:send')
  send(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.messages.send(patientId, dto, auditActor(user));
  }
}
