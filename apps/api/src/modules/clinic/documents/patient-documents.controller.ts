import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { LogPatientAccess } from '@/core/audit/patient-access';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { DOCUMENT_KINDS, DocumentKind } from './documents.types';
import { DocumentsService, uploadOptions } from './documents.service';
import { UploadDocumentDto } from './dto/documents.dto';

@Controller('patients/:patientId/documents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @RequirePermissions('documents:read')
  @LogPatientAccess('documents')
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query('kind') kind?: DocumentKind,
  ) {
    const valid = kind && DOCUMENT_KINDS.includes(kind) ? kind : undefined;
    return this.documents.list(patientId, valid);
  }

  @Get('counts')
  @RequirePermissions('documents:read')
  counts(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.documents.countsFor(patientId);
  }

  /** View links for every drawable image, for the thumbnail grid. */
  @Get('thumbnails')
  @RequirePermissions('documents:read')
  thumbnails(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.documents.thumbnails(patientId, auditActor(user));
  }

  @Post()
  @RequirePermissions('documents:write')
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  upload(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.documents.upload(patientId, file, dto, user.sub).then(publicDocument);
  }
}

/** The profile picture: a patient document the record points at. */
@Controller('patients/:patientId/photo')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientPhotoController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @RequirePermissions('patients:write', 'documents:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  set(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.documents.setProfilePhoto(patientId, file, auditActor(user));
  }

  @Delete()
  @RequirePermissions('patients:write')
  clear(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.documents.clearProfilePhoto(patientId, auditActor(user));
  }
}

/**
 * The storage key is already non-enumerable (see mapDocument); dropping it
 * here as well means a later change to that helper cannot leak it.
 */
function publicDocument<T extends { storageKey?: string }>(doc: T): Omit<T, 'storageKey'> {
  const { storageKey: _key, ...rest } = doc;
  return rest;
}
