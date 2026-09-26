import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { LogPatientAccess } from '@/core/audit/patient-access';
import { PatientHistoryService } from './patient-history.service';

/* ═══════════════════════ controllers ═══════════════════════ */

@Controller('patients/:patientId/history')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientHistoryController {
  constructor(private readonly history: PatientHistoryService) {}

  /** One call for the whole background: allergies, conditions, medications. */
  @Get()
  @RequirePermissions('clinical:read')
  @LogPatientAccess('history')
  summary(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.history.summary(patientId);
  }
}
