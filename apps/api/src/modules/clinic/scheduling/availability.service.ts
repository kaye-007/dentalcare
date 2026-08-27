import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { CreateAvailabilityDto, UpdateAvailabilityDto } from './dto/scheduling.dto';
import { AV_SELECT, AvailabilityRow, EXCLUSION_VIOLATION, FK_VIOLATION, mapAvailability } from './operatories.service';

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
