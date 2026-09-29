import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { Idempotent } from '@/core/idempotency/idempotency.interceptor';
import { ImportBatchDto } from './dto/patient-import.dto';
import { PatientImportService } from './patient-import.service';

@Controller('patient-imports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientImportController {
  constructor(private readonly imports: PatientImportService) {}

  @Get()
  @RequirePermissions('patients:import')
  list() {
    return this.imports.listImports();
  }

  /** Checks a batch and writes nothing. */
  @Post('preview')
  @HttpCode(200)
  @RequirePermissions('patients:import')
  preview(@Body() dto: ImportBatchDto) {
    return this.imports.preview(dto);
  }

  /** Can post opening balances to the ledger, so a repeat must not repeat it. */
  @Post()
  @Idempotent()
  @RequirePermissions('patients:import')
  commit(@Body() dto: ImportBatchDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.imports.commit(dto, auditActor(user));
  }
}
