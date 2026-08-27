import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import {
  AUDIT_ACTIONS,
  ClinicAuditService,
} from '@/core/audit/clinic-audit.service';
import { AuditQueryDto } from './dto/audit.dto';

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
