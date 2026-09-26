import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { UpdateSettingsDto } from './dto/settings.dto';
import { SettingsService } from './settings.service';

@Controller('settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermissions('settings:read')
  get() {
    return this.settings.get();
  }

  @Patch()
  @RequirePermissions('settings:manage')
  update(@Body() dto: UpdateSettingsDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.settings.update(dto, auditActor(user));
  }

  /** Multer's own limit is the hard stop; the service refuses anything over 1 MB. */
  @Post('logo')
  @RequirePermissions('settings:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 1024 * 1024 + 1, files: 1 } }))
  uploadLogo(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.settings.uploadLogo(file, auditActor(user));
  }

  @Delete('logo')
  @RequirePermissions('settings:manage')
  removeLogo(@CurrentUser() user?: AccessTokenPayload) {
    return this.settings.removeLogo(auditActor(user));
  }
}
