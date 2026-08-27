import { SetMetadata } from '@nestjs/common';
import { Permission } from './permissions';

export const PERMISSIONS_METADATA_KEY = 'dentalcare:required-permissions';

/**
 * Declare the permissions a route (or an entire controller) requires.
 *
 * All listed permissions must be held — the check is AND, not OR. That is the
 * conservative reading and the one that matches how these routes actually
 * behave: an endpoint that both reads a patient and writes an invoice needs
 * genuine authority over both.
 *
 *   @RequirePermissions('payroll:manage')
 *   @Post(':id/salary-payments')
 *
 * Requires PermissionsGuard to be active on the route, and JwtAuthGuard to
 * have run first so `req.user` is populated.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_METADATA_KEY, permissions);
