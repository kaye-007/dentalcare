import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/modules/clinic/auth';
import { PermissionsGuard } from '@/core/authz/permissions.guard';
import { RequirePermissions } from '@/core/authz/permissions.decorator';
import { FeatureGuard, RequiresFeature } from '@/core/entitlements/entitlements.service';
import { Idempotent } from '@/core/idempotency/idempotency.interceptor';
import { CurrentUser } from '@/shared/decorators/current-user.decorator';
import { AccessTokenPayload } from '@/shared/types/access-token';
import { auditActor } from '@/core/audit/clinic-audit.service';
import { CashDrawerService } from './cash-drawer.service';
import {
  ApproveDto,
  ApproveWithPinDto,
  ApprovedMovementDto,
  CloseSessionDto,
  CreateDrawerDto,
  DropDto,
  ForceCloseDto,
  ListSessionsQueryDto,
  NoSaleDto,
  OpenSessionDto,
  SetApprovalPinDto,
  SubmitCountDto,
  UpdateDrawerDto,
  UpdatePolicyDto,
} from './dto/cash-drawer.dto';

/**
 * The cash drawer (0014). Every route needs the feature switched on for the
 * clinic; see CashDrawerService for the shape of a shift.
 */
@Controller('drawer')
@UseGuards(JwtAuthGuard, PermissionsGuard, FeatureGuard)
@RequiresFeature('cash_drawer')
export class CashDrawerController {
  constructor(private readonly drawer: CashDrawerService) {}

  /* ── configuration ── */

  @Get('policy')
  @RequirePermissions('settings:read')
  policy() {
    return this.drawer.getPolicy();
  }

  @Put('policy')
  @RequirePermissions('settings:manage')
  updatePolicy(@Body() dto: UpdatePolicyDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.drawer.updatePolicy(dto, auditActor(user));
  }

  @Get('drawers')
  @RequirePermissions('settings:read')
  drawers() {
    return this.drawer.listDrawers();
  }

  @Post('drawers')
  @RequirePermissions('settings:manage')
  createDrawer(@Body() dto: CreateDrawerDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.drawer.createDrawer(dto, auditActor(user));
  }

  @Patch('drawers/:id')
  @RequirePermissions('settings:manage')
  updateDrawer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDrawerDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.updateDrawer(id, dto, auditActor(user));
  }

  @Get('approvers')
  @RequirePermissions('drawer:operate')
  approvers() {
    return this.drawer.approvers();
  }

  @Put('approval-pin')
  @RequirePermissions('drawer:approve')
  setApprovalPin(
    @Body() dto: SetApprovalPinDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.setApprovalPin(dto, auditActor(user));
  }

  /* ── the shift ── */

  @Get('current')
  @RequirePermissions('drawer:operate')
  current(@CurrentUser() user?: AccessTokenPayload) {
    return this.drawer.current(auditActor(user));
  }

  @Post('sessions')
  @Idempotent()
  @RequirePermissions('drawer:operate')
  open(@Body() dto: OpenSessionDto, @CurrentUser() user?: AccessTokenPayload) {
    return this.drawer.open(dto, auditActor(user));
  }

  @Post('sessions/:id/drops')
  @Idempotent()
  @RequirePermissions('drawer:operate')
  drop(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DropDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.drop(id, dto, auditActor(user));
  }

  @Post('sessions/:id/payouts')
  @Idempotent()
  @RequirePermissions('drawer:operate')
  payout(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApprovedMovementDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.approvedMovement('payout', id, dto, auditActor(user));
  }

  @Post('sessions/:id/float')
  @Idempotent()
  @RequirePermissions('drawer:operate')
  addFloat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApprovedMovementDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.approvedMovement('add_float', id, dto, auditActor(user));
  }

  @Post('sessions/:id/no-sale')
  @RequirePermissions('drawer:operate')
  noSale(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NoSaleDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.noSale(id, dto.reason, auditActor(user));
  }

  @Post('sessions/:id/count/start')
  @RequirePermissions('drawer:operate')
  startCount(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.startCount(id, auditActor(user));
  }

  @Post('sessions/:id/count/cancel')
  @RequirePermissions('drawer:operate')
  resumeOpen(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.resumeOpen(id, auditActor(user));
  }

  @Post('sessions/:id/counts')
  @Idempotent()
  @RequirePermissions('drawer:operate')
  submitCount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitCountDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.submitCount(id, dto, auditActor(user));
  }

  @Post('sessions/:id/close')
  @Idempotent()
  @RequirePermissions('drawer:operate')
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseSessionDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.close(id, dto, auditActor(user));
  }

  /* ── approval and oversight ── */

  @Post('sessions/:id/approve')
  @Idempotent()
  @RequirePermissions('drawer:approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.approve(id, dto.reason, auditActor(user));
  }

  /** A manager's approval given with their PIN at the receptionist's device. */
  @Post('sessions/:id/approve-with-pin')
  @Idempotent()
  @RequirePermissions('drawer:operate')
  approveWithPin(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveWithPinDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.approveWithPin(id, dto, auditActor(user));
  }

  @Post('sessions/:id/force-close')
  @Idempotent()
  @RequirePermissions('drawer:approve')
  forceClose(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ForceCloseDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    return this.drawer.forceClose(id, dto, auditActor(user));
  }

  @Get('sessions')
  @RequirePermissions('drawer:read')
  list(@Query() q: ListSessionsQueryDto) {
    return this.drawer.list(q);
  }

  /**
   * One session. `payments:read` is the gate every cash handler and the
   * accountant hold; the service then allows the holder her own session and
   * `drawer:read` any session, and answers 404 to everyone else.
   */
  @Get('sessions/:id')
  @RequirePermissions('payments:read')
  one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AccessTokenPayload) {
    return this.drawer.getSession(id, auditActor(user));
  }
}
