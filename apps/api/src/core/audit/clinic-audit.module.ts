import { Global, Module } from '@nestjs/common';
import { ClinicAuditService } from './clinic-audit.service';
import { PatientAccessGuard, PatientAccessService } from './patient-access';

/**
 * Global on purpose. Almost every tenant module that changes money, accounts,
 * configuration or the clinical record has to write here, and threading an
 * import into each one invites the failure this whole pass exists to prevent:
 * the module somebody forgot to wire up, which then silently records nothing.
 *
 * The record-access log is global for the same reason. @LogPatientAccess on a
 * route instantiates its guard inside that route's module; if the service it
 * needs were not resolvable there, the failure would be a boot error at best
 * and an unlogged read at worst.
 */
@Global()
@Module({
  providers: [ClinicAuditService, PatientAccessService, PatientAccessGuard],
  exports: [ClinicAuditService, PatientAccessService, PatientAccessGuard],
})
export class ClinicAuditModule {}
