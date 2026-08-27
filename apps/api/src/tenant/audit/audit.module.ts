import {
  Controller,
  Get,
  Module,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PermissionsGuard } from '../../core/authz/permissions.guard';
import { RequirePermissions } from '../../core/authz/permissions.decorator';
import { AuthModule } from '../auth/auth.module';
import {
  AUDIT_ACTIONS,
  ClinicAuditService,
} from '../../core/audit/clinic-audit.service';

export class AuditQueryDto {
  @IsOptional() @IsIn(AUDIT_ACTIONS as unknown as string[])
  action?: string;

  @IsOptional() @IsString()
  entityType?: string;

  @IsOptional() @IsUUID()
  entityId?: string;

  @IsOptional() @IsUUID()
  actorUserId?: string;

  @IsOptional() @IsISO8601()
  from?: string;

  @IsOptional() @IsISO8601()
  to?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;
}

/**
 * Reading the clinic's own activity trail. Doctor-only: the log's whole
 * purpose is that the person being recorded cannot curate it, and being able
 * to read every entry is most of the way to knowing which ones to work around.
 *
 * There is no write endpoint, by design. Entries are only ever produced as a
 * side effect of the action they describe, inside its transaction.
 */
@Controller('audit')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AuditController {
  constructor(private readonly audit: ClinicAuditService) {}

  @Get()
  @RequirePermissions('audit:read')
  list(@Query() q: AuditQueryDto) {
    return this.audit.list(q);
  }

  @Get('actions')
  @RequirePermissions('audit:read')
  actions() {
    return { actions: AUDIT_ACTIONS };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [AuditController],
})
export class AuditModule {}
