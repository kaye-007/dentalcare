import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, RefreshDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt.guard';
import { CurrentUser } from './current-user.decorator';
import { AccessTokenPayload } from './auth.service';
import { UsersService } from '../users/users.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly tenant: TenantContextService,
  ) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

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
    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      tenantId: user.tenant_id,
      clinicName: user.clinic_name,
    };
  }
}
