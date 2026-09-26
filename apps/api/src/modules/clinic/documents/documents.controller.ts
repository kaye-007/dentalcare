import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { DocumentsService } from './documents.service';
import { UpdateDocumentDto } from './dto/documents.dto';

@Controller('documents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** Inline signed URL — used to render an X-ray in the browser. */
  @Get(':id/view')
  @RequirePermissions('documents:read')
  view(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AccessTokenPayload) {
    return this.documents.link(id, 'inline', auditActor(user));
  }

  /** Attachment signed URL — used by the download button. */
  @Get(':id/download')
  @RequirePermissions('documents:read')
  download(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.documents.link(id, 'attachment', auditActor(user));
  }

  @Patch(':id')
  @RequirePermissions('documents:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDocumentDto) {
    return this.documents.update(id, dto);
  }

  /** Removing a radiograph is destructive and audited — administrators only. */
  @Delete(':id')
  @RequirePermissions('documents:delete')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.documents.remove(id, auditActor(user));
  }
}
