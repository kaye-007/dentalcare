import type { Role } from '@/core/authz/permissions';

/**
 * The decoded clinic access token.
 *
 * Lives in shared/ because 27 files need the shape and only one of them —
 * AuthService — needs the service that mints it. Importing a service to
 * borrow a type is how a controller ends up coupled to a plane it never
 * calls into.
 */
export interface AccessTokenPayload {
  sub: string;
  tenantId: string;
  role: Role;
  email: string;
}
