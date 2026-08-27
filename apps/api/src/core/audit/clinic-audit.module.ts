import { Global, Module } from '@nestjs/common';
import { ClinicAuditService } from './clinic-audit.service';

/**
 * Global on purpose. Almost every tenant module that changes money, accounts
 * or configuration has to write here, and threading an import into each one
 * invites the failure this whole pass exists to prevent: the module somebody
 * forgot to wire up, which then silently records nothing.
 */
@Global()
@Module({
  providers: [ClinicAuditService],
  exports: [ClinicAuditService],
})
export class ClinicAuditModule {}
