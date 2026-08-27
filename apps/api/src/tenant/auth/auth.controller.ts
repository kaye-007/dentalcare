import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, RefreshDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt.guard';
import { CurrentUser } from './current-user.decorator';
import { AccessTokenPayload } from './auth.service';
import { normalizeRole, permissionsFor } from '../../core/authz/permissions';
import { UsersService } from '../users/users.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { AllowWhenReadOnly } from '../../core/tenancy/read-only.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly tenant: TenantContextService,
  ) {}

  // Credential endpoint: tight per-IP ceiling to blunt credential stuffing.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWhenReadOnly()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @AllowWhenReadOnly()
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  /**
   * Allowed after a trial expires. Withholding writes is a payment lever;
   * withholding someone's ability to rotate their own password is a security
   * regression, and the two must not be confused because they share a verb.
   */
  @AllowWhenReadOnly()
  @UseGuards(JwtAuthGuard)
  @Patch('password')
  changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() current?: AccessTokenPayload,
  ) {
    if (!current) throw new UnauthorizedException();
    return this.auth.changePassword(
      current.sub,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@CurrentUser() current?: AccessTokenPayload) {
    if (!current) throw new UnauthorizedException();
    const user = await this.users.findForAuthById(
      this.tenant.getRequiredTenantId(),
      current.sub,
    );
    if (!user) throw new UnauthorizedException();
    const role = normalizeRole(user.role);
    if (!role) {
      throw new UnauthorizedException('Your account has no valid access role');
    }
    // The client needs the trial state to show a banner and stop offering
    // buttons that will 402. It is advisory only — ReadOnlyGuard is what
    // actually refuses the write.
    const ctx = this.tenant.get();
    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role,
      tenantId: user.tenant_id,
      clinicName: user.clinic_name,
      permissions: permissionsFor(role),
      trial: {
        endsAt: ctx?.trialEndsAt ?? null,
        readOnly: ctx?.readOnly ?? false,
      },
    };
  }
}
