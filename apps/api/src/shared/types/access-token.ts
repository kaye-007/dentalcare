import type { Role } from '@dentalcare/shared';

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
  /**
   * The session row this token was minted for (migration 0005). Lets a
   * password change end every OTHER session while keeping the one it was made
   * from. Absent on a token issued before sessions existed.
   */
  sid?: string;
}
