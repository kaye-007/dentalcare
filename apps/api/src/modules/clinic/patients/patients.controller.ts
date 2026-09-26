import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { PatientsService } from './patients.service';
import {
  ArchivePatientDto,
  CreateNoteDto,
  CreatePatientDto,
  UpdatePatientDto,
} from './dto/patient.dto';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { EnteredInErrorDto } from '@/shared/dto/entered-in-error.dto';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { LogPatientAccess, PatientAccessService } from '@/core/audit/patient-access';

@Controller('patients')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientsController {
  constructor(
    private readonly patients: PatientsService,
    private readonly access: PatientAccessService,
  ) {}

  @Get()
  @RequirePermissions('patients:read')
  list(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.patients.list({
      q,
      status,
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.min(100, Math.max(1, Number(pageSize) || 20)),
    });
  }

  @Get(':id')
  @RequirePermissions('patients:read')
  @LogPatientAccess('record')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.patients.getById(id);
  }

  /** Who opened this patient's record, and which part of it. */
  @Get(':id/access-log')
  @RequirePermissions('audit:read')
  accessLog(@Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string) {
    return this.access.list(id, Number(limit) || 200);
  }

  @Post()
  @RequirePermissions('patients:write')
  create(@Body() dto: CreatePatientDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.patients.create(dto, auditActor(user));
  }

  @Patch(':id')
  @RequirePermissions('patients:write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePatientDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.patients.update(id, dto, auditActor(user));
  }

  @Post(':id/notes')
  @RequirePermissions('history:write')
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateNoteDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.patients.addNote(id, dto.body, auditActor(user));
  }

  /**
   * Archive, not delete. The route is DELETE because that is the verb a
   * client reaches for, but the record is retained — see PatientsService.
   */
  @Delete(':id')
  @RequirePermissions('patients:write')
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArchivePatientDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.patients.archive(id, dto, auditActor(user));
  }

  @Post(':id/restore')
  @RequirePermissions('patients:write')
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.patients.restore(id, auditActor(user));
  }

  /** A note is never edited or deleted; a wrong one is withdrawn with a reason. */
  @Post('notes/:noteId/entered-in-error')
  @RequirePermissions('history:write')
  withdrawNote(
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: EnteredInErrorDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.patients.withdrawNote(noteId, dto.reason, auditActor(user));
  }
}
