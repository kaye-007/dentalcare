import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '@/core/database/database.service';
import { PlatformAuditActor, PlatformAuditService } from '../audit/audit.service';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  price_monthly: number;
  is_active: boolean;
  created_at: string;
  /** Live clinics on the plan: everything but deleted. */
  clinic_count: number;
  /** Active and out of trial — the clinics the next billing run will invoice. */
  paying_count: number;
  /** Minor units: price × paying clinics. */
  mrr: number;
}

/**
 * The price list.
 *
 * A price change is not retroactive and does not need to be: the billing run
 * reads the plan's price at the moment it runs and snapshots it onto the
 * invoice, so issued invoices keep what they said, and the next run bills the
 * new figure.
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: PlatformAuditService,
  ) {}

  /** What the pickers offer: only plans a clinic can be put on today. */
  async listActive() {
    const { rows } = await this.db.adminQuery(
      `SELECT id, code, name, price_monthly
         FROM plans WHERE is_active = true ORDER BY price_monthly`,
    );
    return rows;
  }

  /** Every plan, retired ones included, with what each is worth. */
  async listAll(): Promise<PlanRow[]> {
    const { rows } = await this.db.adminQuery<PlanRow & { mrr: string }>(
      `SELECT p.id, p.code, p.name, p.price_monthly, p.is_active, p.created_at,
              count(t.id) FILTER (WHERE t.status <> 'deleted')::int AS clinic_count,
              count(t.id) FILTER (
                WHERE t.status = 'active'
                  AND (t.trial_ends_at IS NULL OR t.trial_ends_at <= now()))::int AS paying_count,
              (p.price_monthly * count(t.id) FILTER (
                WHERE t.status = 'active'
                  AND (t.trial_ends_at IS NULL OR t.trial_ends_at <= now())))::bigint AS mrr
         FROM plans p
         LEFT JOIN tenants t ON t.plan_id = p.id AND t.deleted_at IS NULL
        GROUP BY p.id
        ORDER BY p.is_active DESC, p.price_monthly, p.name`,
    );
    return rows.map((r) => ({ ...r, mrr: Number(r.mrr) }));
  }

  async create(dto: CreatePlanDto, actor: PlatformAuditActor) {
    if (dto.name.trim().length < 2)
      throw new BadRequestException('Plan name is required');
    return this.db.withAdminTransaction(async (client) => {
      const { rows } = await client
        .query<{ id: string }>(
          `INSERT INTO plans (code, name, price_monthly) VALUES ($1, $2, $3) RETURNING id`,
          [dto.code, dto.name.trim(), dto.priceMonthly],
        )
        .catch((err: { code?: string }) => {
          if (err.code === '23505')
            throw new ConflictException('A plan with that code already exists');
          throw err;
        });
      const id = rows[0]!.id;
      await this.audit.record(client, actor, {
        action: 'plan.created',
        entityType: 'plan',
        entityId: id,
        metadata: {
          code: dto.code,
          name: dto.name.trim(),
          priceMonthly: dto.priceMonthly,
        },
      });
      return { id };
    });
  }

  async update(id: string, dto: UpdatePlanDto, actor: PlatformAuditActor) {
    if (
      dto.name === undefined &&
      dto.priceMonthly === undefined &&
      dto.isActive === undefined
    ) {
      throw new BadRequestException('Nothing to change');
    }
    if (dto.name !== undefined && dto.name.trim().length < 2) {
      throw new BadRequestException('Plan name is required');
    }
    return this.db.withAdminTransaction(async (client) => {
      const { rows } = await client.query<{
        code: string;
        name: string;
        price_monthly: number;
        is_active: boolean;
      }>(
        'SELECT code, name, price_monthly, is_active FROM plans WHERE id = $1 FOR UPDATE',
        [id],
      );
      const before = rows[0];
      if (!before) throw new NotFoundException('Plan not found');

      const next = {
        name: dto.name?.trim() ?? before.name,
        price_monthly: dto.priceMonthly ?? before.price_monthly,
        is_active: dto.isActive ?? before.is_active,
      };
      await client.query(
        'UPDATE plans SET name = $1, price_monthly = $2, is_active = $3 WHERE id = $4',
        [next.name, next.price_monthly, next.is_active, id],
      );

      // One entry per kind of change, so the trail reads "Price changed" and
      // "Plan retired" rather than one entry that has to be diffed by eye.
      const changes: { action: string; metadata: Record<string, unknown> }[] = [];
      if (next.name !== before.name || next.price_monthly !== before.price_monthly) {
        changes.push({
          action: 'plan.updated',
          metadata: {
            code: before.code,
            name: { from: before.name, to: next.name },
            priceMonthly: { from: before.price_monthly, to: next.price_monthly },
          },
        });
      }
      if (next.is_active !== before.is_active) {
        changes.push({
          action: next.is_active ? 'plan.restored' : 'plan.retired',
          metadata: { code: before.code, name: next.name },
        });
      }
      for (const c of changes) {
        await this.audit.record(client, actor, {
          ...c,
          entityType: 'plan',
          entityId: id,
        });
      }
      return {
        id,
        name: next.name,
        priceMonthly: next.price_monthly,
        isActive: next.is_active,
      };
    });
  }
}
