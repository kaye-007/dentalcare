import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestWithUser } from '@/shared/types/request-with-user';
import { AccessTokenPayload } from '@/shared/types/access-token';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenPayload | undefined => {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    return req.user;
  },
);
