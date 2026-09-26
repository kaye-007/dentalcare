import { Global, Module } from '@nestjs/common';
import { MfaService } from './mfa.service';

/**
 * Global because both auth planes, staff management and the platform's
 * tenant support tools all need it, and the keyring it holds must be ONE
 * instance: two services parsing MFA_ENCRYPTION_KEYS separately is two chances
 * to disagree about which key is current.
 */
@Global()
@Module({
  providers: [MfaService],
  exports: [MfaService],
})
export class MfaModule {}
