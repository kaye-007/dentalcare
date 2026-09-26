import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { LogPatientAccess } from '@/core/audit/patient-access';
import { CreatePerioExamDto } from './dto/perio.dto';
import { PerioService } from './perio.service';

/* ═══════════════════════ controllers ═══════════════════════ */

@Controller('patients/:patientId/perio-exams')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PatientPerioController {
  constructor(private readonly perio: PerioService) {}

  @Get()
  @RequirePermissions('clinical:read')
  @LogPatientAccess('perio')
  list(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.perio.listExams(patientId);
  }

  @Post()
  @RequirePermissions('clinical:write')
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreatePerioExamDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.perio.createExam(patientId, dto, auditActor(user));
  }
}
