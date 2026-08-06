import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OwnerGuard } from '../auth/owner.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessTokenPayload } from '../auth/auth.service';
import { AuthModule } from '../auth/auth.module';
import { BCRYPT_ROUNDS } from '../../core/security/bcrypt';

/*
 * Staff = platform access + clinic personnel/payroll tracking.
 *
 * Access roles are EXACTLY two: 'owner' and 'frontdesk'. "Position" is a
 * free-text job title (Dentist, Assistant, Receptionist, Manager, …) — it is
 * descriptive only and grants no permissions.
 *
 * Salary data (amount/note) and the salary payment log are owner-only:
 * frontdesk receives the staff list without payroll fields.
 */

/* ── DTOs ────────────────────────────────────────────────── */
export class CreateStaffDto {
  @IsString() @MinLength(2, { message: 'Full name is required' })
  fullName!: string;

  @IsEmail({}, { message: 'Enter a valid email' })
  email!: string;

  @IsString() @MinLength(8, { message: 'Temporary password must be at least 8 characters' })
  password!: string;

  @IsIn(['owner', 'frontdesk'], { message: 'Access role must be Owner or Frontdesk' })
  role!: 'owner' | 'frontdesk';

  @IsOptional() @IsString() @MaxLength(80)
  position?: string;

  @IsOptional() @IsInt() @Min(1) @Max(100_000_000)
  salaryAmount?: number;

  @IsOptional() @IsString() @MaxLength(300)
  salaryNote?: string;
}

export class UpdateStaffDto {
  @IsOptional() @IsString() @MinLength(2)
  fullName?: string;

  @IsOptional() @IsIn(['owner', 'frontdesk'], { message: 'Access role must be Owner or Frontdesk' })
  role?: 'owner' | 'frontdesk';

  @IsOptional() @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @IsOptional() @IsString() @MaxLength(80)
  position?: string | null;

  @IsOptional() @IsInt() @Min(1) @Max(100_000_000)
  salaryAmount?: number | null;

  @IsOptional() @IsString() @MaxLength(300)
  salaryNote?: string | null;
}

export class ResetStaffPasswordDto {
  @IsString() @MinLength(8, { message: 'New password must be at least 8 characters' })
  password!: string;
}

export class RecordSalaryPaymentDto {
  @IsInt() @Min(1, { message: 'Amount must be positive' })
  amount!: number;

  @IsOptional() @IsISO8601()
  paidOn?: string;

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

/* ── service ─────────────────────────────────────────────── */
interface StaffRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  status: string;
  position: string | null;
  salary_amount: number | null;
  salary_note: string | null;
  created_at: string;
}
const FULL = 'id, full_name, email, role, status, position, salary_amount, salary_note, created_at';

function mapStaff(r: StaffRow, includePayroll: boolean) {
  const base = {
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    role: r.role,
    status: r.status,
    position: r.position,
    createdAt: r.created_at,
  };
  return includePayroll
    ? { ...base, salaryAmount: r.salary_amount, salaryNote: r.salary_note }
    : base;
}

@Injectable()
export class StaffService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  list(includePayroll: boolean) {
    return this.tx(async (client) => {
      const { rows } = await client.query<StaffRow>(
        `SELECT ${FULL} FROM users ORDER BY created_at`,
      );
      return rows.map((r) => mapStaff(r, includePayroll));
    });
  }

  create(dto: CreateStaffDto) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const hash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
      try {
        const { rows } = await client.query<StaffRow>(
          `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status,
                              position, salary_amount, salary_note)
           VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8) RETURNING ${FULL}`,
          [tenantId, dto.email, hash, dto.fullName, dto.role,
           dto.position?.trim() || null, dto.salaryAmount ?? null, dto.salaryNote?.trim() || null],
        );
        return mapStaff(rows[0]!, true);
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictException('A staff member with that email already exists');
        }
        throw err;
      }
    });
  }

  update(id: string, dto: UpdateStaffDto, actorId: string) {
    if (id === actorId && (dto.status === 'disabled' || dto.role === 'frontdesk')) {
      throw new BadRequestException('You cannot disable or demote your own account');
    }
    const cols: Record<string, string> = {
      fullName: 'full_name',
      role: 'role',
      status: 'status',
      position: 'position',
      salaryAmount: 'salary_amount',
      salaryNote: 'salary_note',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      const v = (dto as unknown as Record<string, unknown>)[k];
      if (v !== undefined) {
        params.push(v === '' ? null : v);
        sets.push(`${col} = $${params.length}`);
      }
    }
    return this.tx(async (client) => {
      if (!sets.length) {
        const r = await client.query<StaffRow>(`SELECT ${FULL} FROM users WHERE id = $1`, [id]);
        if (!r.rows[0]) throw new NotFoundException('Staff member not found');
        return mapStaff(r.rows[0], true);
      }
      params.push(id);
      const { rows } = await client.query<StaffRow>(
        `UPDATE users SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length} RETURNING ${FULL}`,
        params,
      );
      if (!rows[0]) throw new NotFoundException('Staff member not found');
      return mapStaff(rows[0], true);
    });
  }

  /**
   * Owner-initiated password reset for a staff member. The owner never sees
   * the existing password, so this sets a new one outright — the recovery path
   * for a locked-out colleague, since the clinic plane has no email flow.
   */
  resetPassword(staffId: string, newPassword: string) {
    return this.tx(async (client) => {
      const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      const res = await client.query(
        'UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1',
        [staffId, hash],
      );
      if (!res.rowCount) throw new NotFoundException('Staff member not found');
      return { reset: true };
    });
  }

  /* ── salary payment log (owner-only) ── */
  recordSalaryPayment(staffId: string, dto: RecordSalaryPaymentDto, actorId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const staff = await client.query<{ position: string | null }>(
        'SELECT position FROM users WHERE id = $1',
        [staffId],
      );
      if (!staff.rowCount) throw new NotFoundException('Staff member not found');
      const { rows } = await client.query(
        `INSERT INTO salary_payments (tenant_id, staff_id, position, amount, paid_on, note, created_by)
         VALUES ($1,$2,$3,$4, coalesce($5::date, CURRENT_DATE), $6, $7)
         RETURNING id, amount, paid_on::text AS paid_on, note, position`,
        [tenantId, staffId, staff.rows[0]!.position, dto.amount,
         dto.paidOn ?? null, dto.note?.trim() || null, actorId],
      );
      const r = rows[0]!;
      return { id: r.id, staffId, amount: r.amount, paidOn: r.paid_on, note: r.note, position: r.position };
    });
  }

  listSalaryPayments() {
    return this.tx(async (client) => {
      const { rows } = await client.query(
        `SELECT sp.id, sp.amount, sp.paid_on::text AS paid_on, sp.note, sp.position,
                u.full_name AS staff_name
           FROM salary_payments sp
           JOIN users u ON u.id = sp.staff_id
          ORDER BY sp.paid_on DESC, sp.created_at DESC
          LIMIT 200`,
      );
      return rows.map((r) => ({
        id: r.id,
        staffName: r.staff_name,
        position: r.position,
        amount: r.amount,
        paidOn: r.paid_on,
        note: r.note,
      }));
    });
  }
}

/* ── controller ──────────────────────────────────────────── */
@Controller('staff')
@UseGuards(JwtAuthGuard)
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  /** All clinic users can read the team list; payroll fields are owner-only. */
  @Get()
  list(@CurrentUser() user?: AccessTokenPayload) {
    return this.staff.list(user?.role === 'owner');
  }

  @Get('salary-payments')
  @UseGuards(OwnerGuard)
  salaryLog() {
    return this.staff.listSalaryPayments();
  }

  @Post()
  @UseGuards(OwnerGuard)
  create(@Body() dto: CreateStaffDto) {
    return this.staff.create(dto);
  }

  @Patch(':id')
  @UseGuards(OwnerGuard)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.staff.update(id, dto, user.sub);
  }

  @Post(':id/password')
  @UseGuards(OwnerGuard)
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetStaffPasswordDto,
  ) {
    return this.staff.resetPassword(id, dto.password);
  }

  @Post(':id/salary-payments')
  @UseGuards(OwnerGuard)
  recordSalary(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordSalaryPaymentDto,
    @CurrentUser() user?: AccessTokenPayload,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.staff.recordSalaryPayment(id, dto, user.sub);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [StaffController],
  providers: [StaffService, OwnerGuard],
})
export class StaffModule {}
