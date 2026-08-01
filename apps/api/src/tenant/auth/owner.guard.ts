import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { RequestWithUser } from './jwt.guard';

/**
 * Restricts a route to clinic owners. Always used AFTER JwtAuthGuard, which
 * attaches the verified token payload to the request. Per the permission
 * matrix: frontdesk can view the treatments catalog but cannot change pricing.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    if (req.user?.role !== 'owner') {
      throw new ForbiddenException('Only the clinic owner can perform this action');
    }
    return true;
  }
}
