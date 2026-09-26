import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { TenantsService } from './tenants.service';
import {
  ChangeSubdomainDto,
  CreateTenantDto,
  DeleteTenantDto,
  ResetUserPasswordDto,
  SetPlanDto,
  SetTrialDto,
  UpdateTenantStatusDto,
} from './dto/tenant.dto';
import { CurrentAdmin, PlatformJwtGuard, PlatformTokenPayload } from '@/modules/platform/auth';
import { PlatformAuditActor } from '../audit/audit.service';

function actorOf(admin?: PlatformTokenPayload): PlatformAuditActor {
  if (!admin) throw new UnauthorizedException();
  return { type: 'platform_admin', id: admin.sub, label: admin.email };
}

@Controller('platform/tenants')
@UseGuards(PlatformJwtGuard)
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  list() {
    return this.tenants.list();
  }

  // Fixed paths before ':id', which would otherwise refuse them as non-UUIDs.

  @Get('overview')
  overview() {
    return this.tenants.overview();
  }

  @Get('subdomain-check')
  checkSubdomain(@Query('name') name = '', @Query('except') except?: string) {
    const valid = except && /^[0-9a-f-]{36}$/i.test(except) ? except : undefined;
    return this.tenants.checkSubdomain(name, valid);
  }

  @Get(':id')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.getById(id);
  }

  @Post()
  create(@Body() dto: CreateTenantDto, @CurrentAdmin() admin?: PlatformTokenPayload) {
    return this.tenants.create(dto, actorOf(admin));
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantStatusDto,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.tenants.updateStatus(id, dto.status, actorOf(admin));
  }

  /** Start, extend, or end a trial. `days: null` means they have paid. */
  @Patch(':id/trial')
  setTrial(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetTrialDto,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.tenants.setTrial(id, dto.days, actorOf(admin));
  }

  @Patch(':id/plan')
  setPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPlanDto,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.tenants.setPlan(id, dto.planId, actorOf(admin));
  }

  @Patch(':id/subdomain')
  changeSubdomain(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeSubdomainDto,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.tenants.changeSubdomain(id, dto.subdomain, actorOf(admin));
  }

  /**
   * POST rather than DELETE: it carries a confirmation and a reason, and it
   * removes nothing — the clinic becomes restorable-deleted.
   */
  @Post(':id/delete')
  softDelete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteTenantDto,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.tenants.softDelete(id, dto, actorOf(admin));
  }

  @Post(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() admin?: PlatformTokenPayload) {
    return this.tenants.restore(id, actorOf(admin));
  }

  /** A JSON snapshot of the clinic's data, credentials redacted. Audited. */
  @Get(':id/export')
  async export(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() admin?: PlatformTokenPayload) {
    const { snapshot, fileName } = await this.tenants.exportSnapshot(id, actorOf(admin));
    return new StreamableFile(Buffer.from(snapshot, 'utf8'), {
      type: 'application/json',
      disposition: `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '-')}"`,
    });
  }

  /** Recovery for a locked-out doctor. Recorded in the clinic's own trail too. */
  @Post(':id/users/:userId/password')
  resetUserPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ResetUserPasswordDto,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.tenants.resetUserPassword(id, userId, dto.password, actorOf(admin));
  }

  /**
   * Recovery for a clinic user who has lost their authenticator AND their
   * recovery codes — the only path for a clinic's sole administrator.
   * Recorded in the clinic's own trail too.
   */
  @Post(':id/users/:userId/mfa/reset')
  resetUserMfa(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.tenants.resetUserMfa(id, userId, actorOf(admin));
  }
}
