import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import {
  CreateAppointmentDto,
  TransitionStatusDto,
  UpdateAppointmentDto,
} from './dto/appointment.dto';
import { APPOINTMENT_STATUSES, allowedTransitions, isStatus } from './status-machine';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';

/** Accepts ?status=a&status=b as well as ?status=a,b. */
function statusList(raw: string | string[] | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = (Array.isArray(raw) ? raw : raw.split(','))
    .map((s) => s.trim())
    .filter((s) => isStatus(s));
  return parts.length ? parts : undefined;
}

@Controller('appointments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AppointmentsController {
  constructor(private readonly appts: AppointmentsService) {}

  /**
   * Range query behind every calendar view. Day, week and month are all just
   * different `from`/`to` windows, so the server needs no notion of a "view".
   */
  @Get()
  @RequirePermissions('appointments:read')
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('patientId') patientId?: string,
    @Query('staffId') staffId?: string,
    @Query('operatoryId') operatoryId?: string,
    @Query('status') status?: string | string[],
    @Query('limit') limit?: string,
  ) {
    return this.appts.list({
      from,
      to,
      patientId,
      staffId,
      operatoryId,
      status: statusList(status),
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * The lifecycle itself, so the UI renders buttons from the server's rules
   * rather than keeping its own copy of the state machine.
   */
  @Get('statuses')
  @RequirePermissions('appointments:read')
  statuses() {
    return {
      statuses: APPOINTMENT_STATUSES,
      transitions: Object.fromEntries(
        APPOINTMENT_STATUSES.map((s) => [s, allowedTransitions(s)]),
      ),
    };
  }

  /** Open slots for a practitioner on a day, honouring their availability. */
  @Get('free-slots')
  @RequirePermissions('appointments:read')
  freeSlots(
    @Query('staffId') staffId: string,
    @Query('date') date: string,
    @Query('duration') duration = '45',
    @Query('operatoryId') operatoryId?: string,
  ) {
    return this.appts.freeSlots({
      staffId,
      date,
      durationMinutes: Number(duration) || 45,
      operatoryId: operatoryId || undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('appointments:read')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.appts.getById(id);
  }

  @Get(':id/history')
  @RequirePermissions('appointments:read')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.appts.history(id);
  }

  @Post()
  @RequirePermissions('appointments:write')
  create(@Body() dto: CreateAppointmentDto, @CurrentUser() user?: AccessTokenPayload) {
    if (!user) throw new UnauthorizedException();
    return this.appts.create(dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions('appointments:write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAppointmentDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.appts.update(id, dto, user.sub);
  }

  /**
   * The only way an appointment's status changes. Enforces the state machine
   * and writes an audit row naming who moved it and why.
   */
  @Post(':id/status')
  @RequirePermissions('appointments:write')
  transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionStatusDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.appts.transition(id, dto, user.sub);
  }
}
