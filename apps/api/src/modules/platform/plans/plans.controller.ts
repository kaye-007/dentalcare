import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentAdmin,
  PlatformJwtGuard,
  PlatformTokenPayload,
} from '@/modules/platform/auth';
import { PlatformAuditActor } from '../audit/audit.service';
import { PlansService } from './plans.service';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';

function actorOf(admin?: PlatformTokenPayload): PlatformAuditActor {
  if (!admin) throw new UnauthorizedException();
  return { type: 'platform_admin', id: admin.sub, label: admin.email };
}

@Controller('platform/plans')
@UseGuards(PlatformJwtGuard)
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /** Plans a clinic can be put on. The shape every picker already reads. */
  @Get()
  list() {
    return this.plans.listActive();
  }

  /** The price list screen: retired plans too, with clinic counts and MRR. */
  @Get('all')
  listAll() {
    return this.plans.listAll();
  }

  @Post()
  create(@Body() dto: CreatePlanDto, @CurrentAdmin() admin?: PlatformTokenPayload) {
    return this.plans.create(dto, actorOf(admin));
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlanDto,
    @CurrentAdmin() admin?: PlatformTokenPayload,
  ) {
    return this.plans.update(id, dto, actorOf(admin));
  }
}
