import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { CreateTenantDto, UpdateTenantStatusDto } from './dto/tenant.dto';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import {
  PlatformJwtGuard,
  CurrentAdmin,
} from '../platform-auth/platform-jwt.guard';
import { PlatformTokenPayload } from '../platform-auth/platform-auth.service';
import { AuditModule } from '../audit/audit.module';
import { AuditActor } from '../audit/audit.service';

function actorOf(admin?: PlatformTokenPayload): AuditActor {
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
}

@Module({
  imports: [PlatformAuthModule, AuditModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
