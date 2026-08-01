import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AccessTokenPayload } from './auth.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';

export interface RequestWithUser extends Request {
  user?: AccessTokenPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly tenant: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing access token');
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const payload = await this.jwt.verifyAsync<
        AccessTokenPayload & { type?: string }
      >(token, { secret: this.config.get<string>('JWT_SECRET') });

      if (payload.type === 'refresh') {
        throw new UnauthorizedException('Wrong token type');
      }

      // A token issued for one clinic cannot be used on another's subdomain.
      const tenantId = this.tenant.getTenantId();
      if (tenantId && payload.tenantId !== tenantId) {
        throw new UnauthorizedException('Token does not match this clinic');
      }

      req.user = payload;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
