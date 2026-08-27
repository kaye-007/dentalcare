import type { Request } from 'express';
import type { AccessTokenPayload } from './access-token';

/**
 * The Express request once JwtAuthGuard has attached the caller.
 *
 * In shared/ because the guard sets it and the CurrentUser decorator reads
 * it, and a decorator reaching into the auth module for the shape closed a
 * cycle through that module's barrel.
 */

export interface RequestWithUser extends Request {
  user?: AccessTokenPayload;
}
