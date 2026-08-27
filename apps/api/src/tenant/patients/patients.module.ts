import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
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
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessTokenPayload } from '../auth/auth.service';
import { AuthModule } from '../auth/auth.module';
import { PermissionsGuard } from '../../core/authz/permissions.guard';
import { RequirePermissions } from '../../core/authz/permissions.decorator';

@Controller('patients')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

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
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.patients.getById(id);
  }

  @Post()
  @RequirePermissions('patients:write')
  create(@Body() dto: CreatePatientDto, @CurrentUser() user?: AccessTokenPayload) {
    if (!user) throw new UnauthorizedException();
    return this.patients.create(dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions('patients:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePatientDto) {
    return this.patients.update(id, dto);
  }

  @Post(':id/notes')
  @RequirePermissions('clinical:write')
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateNoteDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.patients.addNote(id, dto.body, user.sub);
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
    if (!user) throw new UnauthorizedException();
    return this.patients.archive(id, dto, user.sub);
  }

  @Post(':id/restore')
  @RequirePermissions('patients:write')
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.patients.restore(id);
  }

  @Delete('notes/:noteId')
  @RequirePermissions('clinical:write')
  deleteNote(@Param('noteId', ParseUUIDPipe) noteId: string) {
    return this.patients.deleteNote(noteId);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [PatientsController],
  providers: [PatientsService],
})
export class PatientsModule {}
