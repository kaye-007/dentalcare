import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { can } from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { CreateClosureDto } from './dto/closures.dto';

interface ClosureRow {
  id: string;
  staff_id: string | null;
  staff_name: string | null;
  starts_on: string;
  ends_on: string;
  reason: string;
  created_at: string;
}

const SELECT = `
  SELECT c.id, c.staff_id, u.full_name AS staff_name,
         c.starts_on::text AS starts_on, c.ends_on::text AS ends_on,
         c.reason, c.created_at
    FROM schedule_closures c
    LEFT JOIN users u ON u.id = c.staff_id`;

const map = (r: ClosureRow) => ({
  id: r.id,
  staffId: r.staff_id,
  staffName: r.staff_name,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  reason: r.reason,
  createdAt: r.created_at,
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The calendar of exceptions to the weekly schedule: public holidays and
 * closures (the whole clinic) and one clinician's leave.
 *
 * Two permissions, because they are two decisions. Reception holds
 * `availability:manage` and books a colleague's day off; shutting the whole
 * clinic is configuration, and needs `settings:manage`. The route asks for the
 * first and this service for the second, since the body decides which.
 */
@Injectable()
export class ClosuresService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
  ) {}

  list(from?: string, to?: string) {
    const start = from && DATE.test(from) ? from : null;
    const end = to && DATE.test(to) ? to : null;
    return this.db.withTenant(this.tenant.getRequiredTenantId(), async (client) => {
      const { rows } = await client.query<ClosureRow>(
        `${SELECT}
          WHERE ($1::date IS NULL OR c.ends_on >= $1::date)
            AND ($2::date IS NULL OR c.starts_on <= $2::date)
          ORDER BY c.starts_on, c.staff_id NULLS FIRST
          LIMIT 500`,
        [start, end],
      );
      return rows.map(map);
    });
  }

  async create(dto: CreateClosureDto, actor: ClinicAuditActor) {
    const startsOn = dto.startsOn.slice(0, 10);
    const endsOn = dto.endsOn.slice(0, 10);
    if (endsOn < startsOn) throw new BadRequestException('The end date is before the start date');
    this.assertMay(actor, dto.staffId ?? null);

    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      if (dto.staffId) {
        const staff = await client.query('SELECT 1 FROM users WHERE id = $1', [dto.staffId]);
        if (!staff.rowCount) throw new NotFoundException('Staff member not found');
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO schedule_closures (tenant_id, staff_id, starts_on, ends_on, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tenantId, dto.staffId ?? null, startsOn, endsOn, dto.reason.trim(), actor.userId],
      ).catch((err: { code?: string }) => {
        if (err.code === '23514') throw new BadRequestException('A closure can span at most a year');
        throw err;
      });
      const closure = await this.one(client, rows[0]!.id);
      await this.audit.record(client, actor, {
        action: 'schedule.closure_added',
        entityType: 'schedule_closure',
        entityId: closure.id,
        summary: `${closure.staffName ? `${closure.staffName} away` : 'Clinic closed'} ${closure.startsOn}${
          closure.endsOn !== closure.startsOn ? ` to ${closure.endsOn}` : ''
        }: ${closure.reason}`,
        metadata: { staffId: closure.staffId, startsOn, endsOn },
      });
      return closure;
    });
  }

  async remove(id: string, actor: ClinicAuditActor) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), async (client) => {
      const closure = await this.one(client, id);
      this.assertMay(actor, closure.staffId);
      await client.query('DELETE FROM schedule_closures WHERE id = $1', [id]);
      await this.audit.record(client, actor, {
        action: 'schedule.closure_removed',
        entityType: 'schedule_closure',
        entityId: id,
        summary: `Removed ${closure.staffName ? `${closure.staffName}'s time off` : 'a clinic closure'} starting ${closure.startsOn}`,
        metadata: { staffId: closure.staffId, startsOn: closure.startsOn, endsOn: closure.endsOn },
      });
      return { deleted: true as const };
    });
  }

  private async one(client: PoolClient, id: string) {
    const { rows } = await client.query<ClosureRow>(`${SELECT} WHERE c.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('Closure not found');
    return map(rows[0]);
  }

  private assertMay(actor: ClinicAuditActor, staffId: string | null) {
    if (staffId === null && !can(actor.role, 'settings:manage')) {
      throw new ForbiddenException('Closing the whole clinic is changed in clinic settings, by an administrator');
    }
  }
}

/**
 * Whether a clinician cannot be booked on a date: the clinic is closed, or
 * they are away. Read inside the caller's tenant transaction.
 */
export async function closureOn(
  client: PoolClient,
  staffId: string,
  date: string,
): Promise<{ reason: string; wholeClinic: boolean } | null> {
  const { rows } = await client.query<{ reason: string; staff_id: string | null }>(
    `SELECT reason, staff_id FROM schedule_closures
      WHERE $2::date BETWEEN starts_on AND ends_on
        AND (staff_id IS NULL OR staff_id = $1)
      ORDER BY staff_id NULLS FIRST
      LIMIT 1`,
    [staffId, date],
  );
  const row = rows[0];
  return row ? { reason: row.reason, wholeClinic: row.staff_id === null } : null;
}
