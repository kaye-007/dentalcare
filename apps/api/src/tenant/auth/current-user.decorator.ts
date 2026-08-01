import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestWithUser } from './jwt.guard';
import { AccessTokenPayload } from './auth.service';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenPayload | undefined => {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    return req.user;
  },
);
