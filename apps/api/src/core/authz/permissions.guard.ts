import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestWithUser } from '@/shared/types/request-with-user';
import { PERMISSIONS_METADATA_KEY } from './permissions.decorator';
import { Permission, canAll, normalizeRole } from '@dentalcare/shared';

/**
 * Enforces @RequirePermissions. Always used AFTER JwtAuthGuard, which verifies
 * the token and attaches its payload to the request.
 *
 * Fails closed at every branch: a route with no declared permissions is
 * allowed (it is simply an authenticated route), but a request with no user,
 * or a user whose role string cannot be resolved to a known role, is refused.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Method-level declarations override controller-level ones.
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const user = req.user;
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const role = normalizeRole(user.role);
    if (!role) {
      // An unknown role is a data or deployment fault, never a reason to allow.
      throw new ForbiddenException('Your account has no valid access role');
    }

    if (!canAll(role, required)) {
      throw new ForbiddenException(
        `Your role (${role}) is not permitted to perform this action`,
      );
    }

    return true;
  }
}
