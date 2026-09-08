import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { CreateOperatoryDto, UpdateOperatoryDto } from './dto/scheduling.dto';

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

export const EXCLUSION_VIOLATION = '23P01';

export const FK_VIOLATION = '23503';

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

const OP_COLS = 'id, name, description, sort_order, color, is_active, created_at';

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
            tenantId,
            dto.name,
            dto.description ?? null,
            dto.sortOrder ?? 0,
            dto.color ?? null,
            dto.isActive ?? true,
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

      const { rowCount } = await client.query('DELETE FROM operatories WHERE id = $1', [
        id,
      ]);
      if (!rowCount) throw new NotFoundException('Room not found');
      return { deleted: true as const, deactivated: false as const };
    });
  }
}

/* ═══════════════════════ availability ═══════════════════════ */

export interface AvailabilityRow {
  id: string;
  staff_id: string;
  staff_name: string | null;
  weekday: number;
  starts_at: string;
  ends_at: string;
  operatory_id: string | null;
  operatory_name: string | null;
}

export const mapAvailability = (r: AvailabilityRow) => ({
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

export const AV_SELECT = `
  SELECT a.id, a.staff_id, u.full_name AS staff_name, a.weekday,
         a.starts_at::text AS starts_at, a.ends_at::text AS ends_at,
         a.operatory_id, o.name AS operatory_name
    FROM staff_availability a
    LEFT JOIN users u ON u.id = a.staff_id
    LEFT JOIN operatories o ON o.id = a.operatory_id`;
