import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { CreatePartnerDto, UpdatePartnerDto } from './dto/partners.dto';

export type PartnerKind = 'lab' | 'supplier';

interface PartnerRow {
  id: string;
  kind: PartnerKind;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  is_active: boolean;
}

const map = (r: PartnerRow) => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  phone: r.phone,
  email: r.email,
  notes: r.notes,
  isActive: r.is_active,
});

const NOUN: Record<PartnerKind, string> = { lab: 'lab', supplier: 'supplier' };

/** Blank means "none": a cleared phone is NULL, not an empty string. */
const blank = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);

/**
 * The laboratories and suppliers a clinic works with (0020). One service for
 * both, because to the clinic they are the same kind of thing — someone
 * outside it to call or message — and the routes that read and write them
 * carry the permission that fits each (labs: `lab:*`, suppliers:
 * `inventory:*`).
 */
@Injectable()
export class PartnersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  list(kind: PartnerKind, includeRetired = false) {
    return this.tx(async (client) => {
      const { rows } = await client.query<PartnerRow>(
        `SELECT id, kind, name, phone, email, notes, is_active
           FROM partners
          WHERE kind = $1 ${includeRetired ? '' : 'AND is_active'}
          ORDER BY is_active DESC, lower(name)`,
        [kind],
      );
      return rows.map(map);
    });
  }

  create(kind: PartnerKind, dto: CreatePartnerDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      let row: PartnerRow;
      try {
        const { rows } = await client.query<PartnerRow>(
          `INSERT INTO partners (tenant_id, kind, name, phone, email, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, kind, name, phone, email, notes, is_active`,
          [
            tenantId,
            kind,
            dto.name.trim(),
            blank(dto.phone) ?? null,
            blank(dto.email) ?? null,
            blank(dto.notes) ?? null,
            actor.userId,
          ],
        );
        row = rows[0]!;
      } catch (err) {
        this.rethrowDuplicate(err, kind, dto.name);
      }
      await this.audit.record(client, actor, {
        action: 'partner.created',
        entityType: 'partner',
        entityId: row.id,
        summary: `Added ${NOUN[kind]} ${row.name}`,
        metadata: { kind },
      });
      return map(row);
    });
  }

  update(kind: PartnerKind, id: string, dto: UpdatePartnerDto, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const sets: string[] = [];
      const params: unknown[] = [id, kind];
      const set = (column: string, value: unknown) => {
        if (value === undefined) return;
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      set('name', dto.name?.trim());
      set('phone', blank(dto.phone));
      set('email', blank(dto.email));
      set('notes', blank(dto.notes));
      set('is_active', dto.isActive);
      if (sets.length === 0) {
        const { rows } = await client.query<PartnerRow>(
          `SELECT id, kind, name, phone, email, notes, is_active
             FROM partners WHERE id = $1 AND kind = $2`,
          params,
        );
        if (!rows[0]) throw new NotFoundException(`That ${NOUN[kind]} was not found`);
        return map(rows[0]);
      }
      let row: PartnerRow | undefined;
      try {
        const { rows } = await client.query<PartnerRow>(
          `UPDATE partners SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1 AND kind = $2
            RETURNING id, kind, name, phone, email, notes, is_active`,
          params,
        );
        row = rows[0];
      } catch (err) {
        this.rethrowDuplicate(err, kind, dto.name ?? '');
      }
      if (!row) throw new NotFoundException(`That ${NOUN[kind]} was not found`);
      await this.audit.record(client, actor, {
        action: 'partner.updated',
        entityType: 'partner',
        entityId: row.id,
        summary:
          dto.isActive === false
            ? `Retired ${NOUN[kind]} ${row.name}`
            : `Updated ${NOUN[kind]} ${row.name}`,
        metadata: { kind, fields: Object.keys(dto) },
      });
      return map(row);
    });
  }

  private rethrowDuplicate(err: unknown, kind: PartnerKind, name: string): never {
    if ((err as { code?: string }).code === '23505') {
      throw new ConflictException(
        `A ${NOUN[kind]} called “${name.trim()}” is already on the list.`,
      );
    }
    throw err;
  }
}
