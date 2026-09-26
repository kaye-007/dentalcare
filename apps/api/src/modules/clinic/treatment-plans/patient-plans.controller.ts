import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { LogPatientAccess } from '@/core/audit/patient-access';
import { PLAN_STATUSES, type PlanStatus } from './cost-engine';
import { CreatePlanDto } from './dto/treatment-plans.dto';
import { TreatmentPlansService } from './treatment-plans.service';

/* ═══════════════════════ controllers ═══════════════════════ */

@Controller('patients/:patientId/treatment-plans')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientPlansController {
  constructor(private readonly plans: TreatmentPlansService) {}

  @Get()
  @RequirePermissions('clinical:read')
  @LogPatientAccess('treatment_plans')
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query('status') status?: string,
  ) {
    const valid = PLAN_STATUSES.includes(status as PlanStatus)
      ? (status as PlanStatus)
      : undefined;
    return this.plans.listForPatient(patientId, valid);
  }

  @Post()
  @RequirePermissions('plans:write')
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreatePlanDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.plans.create(patientId, dto, user.sub);
  }
}
