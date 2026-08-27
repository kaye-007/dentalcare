import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { DOCUMENT_KINDS, DocumentKind } from './documents.types';
import { DocumentsService, uploadOptions } from './documents.service';
import { UploadDocumentDto } from './dto/documents.dto';

@Controller('patients/:patientId/documents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @RequirePermissions('documents:read')
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

  @Post()
  @RequirePermissions('documents:write')
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  upload(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.documents.upload(patientId, file, dto, user.sub);
  }
}
