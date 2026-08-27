import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { TenantContextService } from './tenant-context';

export const ALLOW_WHEN_READ_ONLY = 'dentalcare:allow-when-read-only';

/**
 * Marks a route that must keep working after a trial expires.
 *
 * Only signing in belongs here. A clinic whose trial ran out must still be
 * able to log in and look at what they built — that is the entire argument
 * for paying, and locking them out of it is the one thing that guarantees
 * they will not.
 */
export const AllowWhenReadOnly = () => SetMetadata(ALLOW_WHEN_READ_ONLY, true);

/** Methods that cannot change anything, so they are never blocked. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Turns an expired trial into a read-only clinic.
 *
 * Registered globally, so a new controller is covered the day it is written
 * rather than the day somebody remembers to add it — the same reasoning as
 * the route-coverage test in R1, applied to a different failure.
 *
 * It is a no-op outside the clinic plane: platform routes never enter a
 * tenant context, so `isReadOnly()` is false and every request passes.
 *
 * 402 rather than 403: the clinic is not forbidden, it has not paid. That
 * distinction is what lets the UI show "your trial ended" instead of
 * "access denied", which are very different messages to a prospect.
 */
@Injectable()
export class ReadOnlyGuard implements CanActivate {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.tenant.isReadOnly()) return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_WHEN_READ_ONLY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;

    throw new HttpException(
      {
        code: 'trial_expired',
        message:
          'This clinic\u2019s trial has ended. Everything you entered is still here and still readable \u2014 subscribe to start adding again.',
        trialEndsAt: this.tenant.get()?.trialEndsAt ?? null,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
