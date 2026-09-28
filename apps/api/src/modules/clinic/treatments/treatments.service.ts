import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditService, ClinicAuditActor } from '@/core/audit/clinic-audit.service';
import { vatCategoryOf } from '@dentalcare/shared';
import { moneyText } from '@/core/money/clinic-currency';
import { CreateTreatmentDto, UpdateTreatmentDto } from './dto/treatments.dto';

/* ── service ─────────────────────────────────────────────── */
interface Row {
  id: string;
  name: string;
  price: number;
  duration_minutes: number;
  visit_type: string | null;
  status: string;
  is_taxable: boolean;
}

const FULL = 'id, name, price, duration_minutes, visit_type, status, is_taxable';

const map = (r: Row) => ({
  id: r.id,
  name: r.name,
  price: r.price,
  durationMinutes: r.duration_minutes,
  visitType: r.visit_type,
  status: r.status,
  /** TVSH: 'medical' is exempt, 'cosmetic' carries the clinic's VAT rate. */
  vatCategory: vatCategoryOf(r.is_taxable),
});

@Injectable()
export class TreatmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  list(opts: { q?: string; status?: string }) {
    return this.tx(async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.status === 'active' || opts.status === 'inactive') {
        params.push(opts.status);
        where.push(`status = $${params.length}`);
      }
      if (opts.q?.trim()) {
        params.push(`%${opts.q.trim()}%`);
        where.push(`name ILIKE $${params.length}`);
      }
      const { rows } = await client.query<Row>(
        `SELECT ${FULL} FROM treatments
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY name`,
        params,
      );
      return rows.map(map);
    });
  }

  create(dto: CreateTreatmentDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      try {
        const { rows } = await client.query<Row>(
          `INSERT INTO treatments (tenant_id, name, price, duration_minutes, visit_type, status, is_taxable)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${FULL}`,
          [
            tenantId,
            dto.name,
            dto.price,
            dto.durationMinutes,
            dto.visitType ?? null,
            dto.status ?? 'active',
            dto.vatCategory === 'cosmetic',
          ],
        );
        await this.audit.record(client, actor, {
          action: 'treatment.created',
          entityType: 'treatment',
          entityId: rows[0]!.id,
          summary: `Added "${dto.name}" at ${await moneyText(client, dto.price)}`,
          metadata: {
            name: dto.name,
            price: dto.price,
            vatCategory: dto.vatCategory ?? 'medical',
          },
        });
        return map(rows[0]!);
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictException('A treatment with that name already exists');
        }
        throw err;
      }
    });
  }

  update(id: string, dto: UpdateTreatmentDto, actor: ClinicAuditActor) {
    const cols: Record<string, string> = {
      name: 'name',
      price: 'price',
      durationMinutes: 'duration_minutes',
      visitType: 'visit_type',
      status: 'status',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      const v = (dto as unknown as Record<string, unknown>)[k];
      if (v !== undefined) {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (dto.vatCategory !== undefined) {
      params.push(dto.vatCategory === 'cosmetic');
      sets.push(`is_taxable = $${params.length}`);
    }
    return this.tx(async (client) => {
      if (!sets.length) {
        const r = await client.query<Row>(
          `SELECT ${FULL} FROM treatments WHERE id = $1`,
          [id],
        );
        if (!r.rows[0]) throw new NotFoundException('Treatment not found');
        return map(r.rows[0]);
      }
      // Repricing is the quietest way to move money in a clinic, so the old
      // price is captured before the write, not inferred afterwards.
      const before = await client.query<Row>(
        `SELECT ${FULL} FROM treatments WHERE id = $1`,
        [id],
      );
      if (!before.rows[0]) throw new NotFoundException('Treatment not found');
      params.push(id);
      const { rows } = await client.query<Row>(
        `UPDATE treatments SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length} RETURNING ${FULL}`,
        params,
      );
      if (!rows[0]) throw new NotFoundException('Treatment not found');
      const prev = before.rows[0];
      const next = rows[0];
      const repriced = prev.price !== next.price;
      // A category change moves TVSH on every future invoice for this work,
      // so it is said in the summary rather than folded into "Updated".
      const recategorised = prev.is_taxable !== next.is_taxable;
      const vatNote = recategorised
        ? ` (TVSH category now ${vatCategoryOf(next.is_taxable)})`
        : '';
      await this.audit.record(client, actor, {
        action: 'treatment.updated',
        entityType: 'treatment',
        entityId: id,
        summary: repriced
          ? `Repriced "${next.name}" from ${prev.price} to ${next.price}${vatNote}`
          : `Updated "${next.name}"${vatNote}`,
        metadata: {
          name: next.name,
          ...(repriced ? { priceFrom: prev.price, priceTo: next.price } : {}),
          ...(recategorised
            ? {
                vatCategoryFrom: vatCategoryOf(prev.is_taxable),
                vatCategoryTo: vatCategoryOf(next.is_taxable),
              }
            : {}),
        },
      });
      return map(rows[0]);
    });
  }
}
