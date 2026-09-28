import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PlatformTokenPayload } from './platform-auth.service';
import { platformJwtSecret } from './platform-secret';

export interface RequestWithAdmin extends Request {
  admin?: PlatformTokenPayload;
}

@Injectable()
export class PlatformJwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithAdmin>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing access token');
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const payload = await this.jwt.verifyAsync<PlatformTokenPayload>(token, {
        secret: platformJwtSecret(this.config),
      });
      if (payload.scope !== 'platform') {
        throw new UnauthorizedException('Not a platform token');
      }
      req.admin = payload;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}

export const CurrentAdmin = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): PlatformTokenPayload | undefined => {
    return ctx.switchToHttp().getRequest<RequestWithAdmin>().admin;
  },
);
