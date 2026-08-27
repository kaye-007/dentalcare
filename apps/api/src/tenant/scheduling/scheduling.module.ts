import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessTokenPayload } from '../auth/auth.service';
import { PermissionsGuard } from '../../core/authz/permissions.guard';
import { RequirePermissions } from '../../core/authz/permissions.decorator';
import { can, normalizeRole } from '../../core/authz/permissions';
import { AuthModule } from '../auth/auth.module';

/**
 * Clinic capacity: the rooms treatment happens in, and when each dentist works.
 *
 * Both are configuration rather than clinical data, but availability has one
 * exception worth stating: a dentist may edit their OWN schedule without
 * holding `availability:manage`. Requiring an administrator to record that a
 * dentist now works Thursdays is friction with no safety benefit — the person
 * is authoritative about their own hours.
 */

const UNIQUE_VIOLATION = '23505';
const EXCLUSION_VIOLATION = '23P01';
const FK_VIOLATION = '23503';

/* ══════════════════════════ DTOs ══════════════════════════ */

export class CreateOperatoryDto {
  @IsString() @MinLength(1, { message: 'Room name is required' }) @MaxLength(80)
  name!: string;

  @IsOptional() @IsString() @MaxLength(200)
  description?: string;

  @IsOptional() @IsInt() @Min(0) @Max(999)
  sortOrder?: number;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Colour must be a hex value like #2f6f62' })
  color?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class UpdateOperatoryDto extends CreateOperatoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80)
  declare name: string;
}

/** 'HH:MM' or 'HH:MM:SS' in clinic-local time. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class CreateAvailabilityDto {
  @IsUUID()
  staffId!: string;

  @IsInt() @Min(0, { message: 'Weekday must be 0 (Sunday) to 6 (Saturday)' })
  @Max(6, { message: 'Weekday must be 0 (Sunday) to 6 (Saturday)' })
  weekday!: number;

  @Matches(TIME_RE, { message: 'Start time must be HH:MM' })
  startsAt!: string;

  @Matches(TIME_RE, { message: 'End time must be HH:MM' })
  endsAt!: string;

  @IsOptional() @IsUUID()
  operatoryId?: string;
}

export class UpdateAvailabilityDto {
  @IsOptional() @IsInt() @Min(0) @Max(6)
  weekday?: number;

  @IsOptional() @Matches(TIME_RE, { message: 'Start time must be HH:MM' })
  startsAt?: string;

  @IsOptional() @Matches(TIME_RE, { message: 'End time must be HH:MM' })
  endsAt?: string;

  @IsOptional() @IsUUID()
  operatoryId?: string | null;
}

/* ═══════════════════════ operatories ═══════════════════════ */

interface OperatoryRow {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  color: string | null;
  is_active: boolean;
  created_at: string;
}

const mapOperatory = (r: OperatoryRow) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  sortOrder: r.sort_order,
  color: r.color,
  isActive: r.is_active,
  createdAt: r.created_at,
});

const OP_COLS =
  'id, name, description, sort_order, color, is_active, created_at';

@Injectable()
export class OperatoriesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  async list(includeInactive: boolean) {
    return this.tx(async (client) => {
      const { rows } = await client.query<OperatoryRow>(
        `SELECT ${OP_COLS} FROM operatories
          ${includeInactive ? '' : 'WHERE is_active'}
          ORDER BY sort_order, lower(name)`,
      );
      return rows.map(mapOperatory);
    });
  }

  async create(dto: CreateOperatoryDto) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      try {
        const { rows } = await client.query<OperatoryRow>(
          `INSERT INTO operatories
             (tenant_id, name, description, sort_order, color, is_active)
           VALUES ($1, btrim($2), $3, $4, $5, $6)
           RETURNING ${OP_COLS}`,
          [
            tenantId, dto.name, dto.description ?? null,
            dto.sortOrder ?? 0, dto.color ?? null, dto.isActive ?? true,
          ],
        );
        return mapOperatory(rows[0]);
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictException(`A room named "${dto.name.trim()}" already exists`);
        }
        throw err;
      }
    });
  }

  async update(id: string, dto: UpdateOperatoryDto) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (dto.name !== undefined) push('name', dto.name.trim());
    if (dto.description !== undefined) push('description', dto.description || null);
    if (dto.sortOrder !== undefined) push('sort_order', dto.sortOrder);
    if (dto.color !== undefined) push('color', dto.color || null);
    if (dto.isActive !== undefined) push('is_active', dto.isActive);
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      try {
        const { rows } = await client.query<OperatoryRow>(
          `UPDATE operatories SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1 RETURNING ${OP_COLS}`,
          params,
        );
        if (!rows[0]) throw new NotFoundException('Room not found');
        return mapOperatory(rows[0]);
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictException('A room with that name already exists');
        }
        throw err;
      }
    });
  }

  /**
   * Deactivate rather than delete when the room has history. Appointments
   * reference it, and a room that vanishes takes the record of where treatment
   * happened with it. A never-used room is deleted outright.
   */
  async remove(id: string) {
    return this.tx(async (client) => {
      const { rows: used } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM appointments WHERE operatory_id = $1',
        [id],
      );
      if (Number(used[0]?.count ?? 0) > 0) {
        const { rows } = await client.query<OperatoryRow>(
          `UPDATE operatories SET is_active = false, updated_at = now()
            WHERE id = $1 RETURNING ${OP_COLS}`,
          [id],
        );
        if (!rows[0]) throw new NotFoundException('Room not found');
        return {
          deleted: false as const,
          deactivated: true as const,
          appointmentsUsingRoom: Number(used[0].count),
          operatory: mapOperatory(rows[0]),
        };
      }

      const { rowCount } = await client.query('DELETE FROM operatories WHERE id = $1', [id]);
      if (!rowCount) throw new NotFoundException('Room not found');
      return { deleted: true as const, deactivated: false as const };
    });
  }
}

/* ═══════════════════════ availability ═══════════════════════ */

interface AvailabilityRow {
  id: string;
  staff_id: string;
  staff_name: string | null;
  weekday: number;
  starts_at: string;
  ends_at: string;
  operatory_id: string | null;
  operatory_name: string | null;
}

const mapAvailability = (r: AvailabilityRow) => ({
  id: r.id,
  staffId: r.staff_id,
  staffName: r.staff_name,
  weekday: r.weekday,
  // Postgres `time` renders as HH:MM:SS; the UI wants HH:MM.
  startsAt: r.starts_at.slice(0, 5),
  endsAt: r.ends_at.slice(0, 5),
  operatoryId: r.operatory_id,
  operatoryName: r.operatory_name,
});

const AV_SELECT = `
  SELECT a.id, a.staff_id, u.full_name AS staff_name, a.weekday,
         a.starts_at::text AS starts_at, a.ends_at::text AS ends_at,
         a.operatory_id, o.name AS operatory_name
    FROM staff_availability a
    LEFT JOIN users u ON u.id = a.staff_id
    LEFT JOIN operatories o ON o.id = a.operatory_id`;

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  async list(staffId?: string) {
    return this.tx(async (client) => {
      const params: unknown[] = [];
      let where = '';
      if (staffId) {
        params.push(staffId);
        where = `WHERE a.staff_id = $${params.length}`;
      }
      const { rows } = await client.query<AvailabilityRow>(
        `${AV_SELECT} ${where} ORDER BY a.weekday, a.starts_at`,
        params,
      );
      return rows.map(mapAvailability);
    });
  }

  async create(dto: CreateAvailabilityDto) {
    if (dto.endsAt <= dto.startsAt) {
      throw new BadRequestException('End time must be after start time');
    }
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const staff = await client.query('SELECT 1 FROM users WHERE id = $1', [dto.staffId]);
      if (!staff.rowCount) throw new NotFoundException('Staff member not found');

      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO staff_availability
             (tenant_id, staff_id, weekday, starts_at, ends_at, operatory_id)
           VALUES ($1,$2,$3,$4::time,$5::time,$6) RETURNING id`,
          [tenantId, dto.staffId, dto.weekday, dto.startsAt, dto.endsAt, dto.operatoryId ?? null],
        );
        const { rows: full } = await client.query<AvailabilityRow>(
          `${AV_SELECT} WHERE a.id = $1`, [rows[0].id],
        );
        return mapAvailability(full[0]);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === EXCLUSION_VIOLATION) {
          throw new ConflictException(
            'That overlaps a shift this person already works on that day',
          );
        }
        if (code === FK_VIOLATION) {
          throw new NotFoundException('That room does not exist');
        }
        throw err;
      }
    });
  }

  async update(id: string, dto: UpdateAvailabilityDto) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (frag: string, value: unknown) => {
      params.push(value);
      sets.push(frag.replace('$$', `$${params.length}`));
    };
    if (dto.weekday !== undefined) push('weekday = $$', dto.weekday);
    if (dto.startsAt !== undefined) push('starts_at = $$::time', dto.startsAt);
    if (dto.endsAt !== undefined) push('ends_at = $$::time', dto.endsAt);
    if (dto.operatoryId !== undefined) push('operatory_id = $$', dto.operatoryId ?? null);
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      try {
        const { rows } = await client.query<{ id: string }>(
          `UPDATE staff_availability SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1 RETURNING id`,
          params,
        );
        if (!rows[0]) throw new NotFoundException('Availability entry not found');
        const { rows: full } = await client.query<AvailabilityRow>(
          `${AV_SELECT} WHERE a.id = $1`, [id],
        );
        return mapAvailability(full[0]);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === EXCLUSION_VIOLATION) {
          throw new ConflictException('That overlaps another shift on the same day');
        }
        // The times-ordered CHECK fires as 23514.
        if (code === '23514') {
          throw new BadRequestException('End time must be after start time');
        }
        throw err;
      }
    });
  }

  async remove(id: string) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM staff_availability WHERE id = $1', [id],
      );
      if (!rowCount) throw new NotFoundException('Availability entry not found');
      return { deleted: true as const };
    });
  }

  /** Who owns this entry — used to allow self-service editing. */
  async ownerOf(id: string): Promise<string | null> {
    return this.tx(async (client) => {
      const { rows } = await client.query<{ staff_id: string }>(
        'SELECT staff_id FROM staff_availability WHERE id = $1', [id],
      );
      return rows[0]?.staff_id ?? null;
    });
  }
}

/* ═══════════════════════ controllers ═══════════════════════ */

@Controller('operatories')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OperatoriesController {
  constructor(private readonly operatories: OperatoriesService) {}

  /** Everyone schedules, so everyone reads the room list. */
  @Get()
  @RequirePermissions('appointments:read')
  list(@Query('includeInactive') includeInactive?: string) {
    return this.operatories.list(includeInactive === '1' || includeInactive === 'true');
  }

  @Post()
  @RequirePermissions('operatories:manage')
  create(@Body() dto: CreateOperatoryDto) {
    return this.operatories.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('operatories:manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOperatoryDto) {
    return this.operatories.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('operatories:manage')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.operatories.remove(id);
  }
}

@Controller('availability')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @RequirePermissions('appointments:read')
  list(@Query('staffId') staffId?: string) {
    return this.availability.list(staffId);
  }

  /**
   * A dentist may set their own hours; changing someone else's needs
   * `availability:manage`.
   */
  @Post()
  @RequirePermissions('appointments:read')
  create(@Body() dto: CreateAvailabilityDto, @CurrentUser() user: AccessTokenPayload) {
    this.assertMayEdit(user, dto.staffId);
    return this.availability.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('appointments:read')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAvailabilityDto,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    const owner = await this.availability.ownerOf(id);
    if (!owner) throw new NotFoundException('Availability entry not found');
    this.assertMayEdit(user, owner);
    return this.availability.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('appointments:read')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    const owner = await this.availability.ownerOf(id);
    if (!owner) throw new NotFoundException('Availability entry not found');
    this.assertMayEdit(user, owner);
    return this.availability.remove(id);
  }

  private assertMayEdit(user: AccessTokenPayload, staffId: string) {
    if (user.sub === staffId) return;
    const role = normalizeRole(user.role);
    if (!role || !can(role, 'availability:manage')) {
      throw new ForbiddenException(
        "You can only change your own working hours. Ask an administrator to change someone else's.",
      );
    }
  }
}

@Module({
  imports: [AuthModule],
  controllers: [OperatoriesController, AvailabilityController],
  providers: [OperatoriesService, AvailabilityService],
  exports: [OperatoriesService, AvailabilityService],
})
export class SchedulingModule {}
