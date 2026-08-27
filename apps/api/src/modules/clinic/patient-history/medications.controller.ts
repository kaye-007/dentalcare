import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { CreateMedicationDto, UpdateMedicationDto } from './dto/patient-history.dto';
import { PatientHistoryService } from './patient-history.service';

@Controller('patients/:patientId/medications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MedicationsController {
  constructor(private readonly history: PatientHistoryService) {}

  @Get()
  @RequirePermissions('clinical:read')
  list(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.history.listMedications(patientId);
  }

  @Post()
  @RequirePermissions('clinical:write')
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateMedicationDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.history.createMedication(patientId, dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions('clinical:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMedicationDto) {
    return this.history.updateMedication(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('clinical:write')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.history.deleteMedication(id);
  }
}
