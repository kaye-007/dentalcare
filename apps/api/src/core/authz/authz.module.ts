import { Global, Module } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';

/**
 * Global so every feature module can list PermissionsGuard in @UseGuards
 * without importing a module or re-declaring it as a provider.
 */
@Global()
@Module({
  providers: [PermissionsGuard],
  exports: [PermissionsGuard],
})
export class AuthzModule {}
