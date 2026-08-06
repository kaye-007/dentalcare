import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService, AuditActor } from '../audit/audit.service';
import { BCRYPT_ROUNDS } from '../../core/security/bcrypt';
import { CreateTenantDto } from './dto/tenant.dto';

const RESERVED = ['www', 'admin', 'api', 'app', 'mail', 'static'];

@Injectable()
export class TenantsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const { rows } = await this.db.adminQuery(
      `SELECT t.id, t.name, t.subdomain, t.status, t.trial_ends_at, t.created_at,
              p.name AS plan_name,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
              (SELECT email FROM users u
                WHERE u.tenant_id = t.id AND u.role = 'owner'
                ORDER BY u.created_at LIMIT 1) AS owner_email
         FROM tenants t
         LEFT JOIN plans p ON p.id = t.plan_id
        ORDER BY t.created_at DESC`,
    );
    return rows;
  }

  async getById(id: string) {
    const { rows } = await this.db.adminQuery(
      `SELECT t.id, t.name, t.subdomain, t.status, t.trial_ends_at, t.created_at,
              p.name AS plan_name, p.id AS plan_id
         FROM tenants t
         LEFT JOIN plans p ON p.id = t.plan_id
        WHERE t.id = $1`,
      [id],
    );
    const tenant = rows[0];
    if (!tenant) throw new NotFoundException('Tenant not found');

    const owners = await this.db.adminQuery(
      `SELECT email, full_name, role, status
         FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [id],
    );
    const audit = await this.audit.listForEntity('tenant', id);
    return { ...tenant, staff: owners.rows, audit };
  }

  async create(dto: CreateTenantDto, actor: AuditActor) {
    const subdomain = dto.subdomain.toLowerCase();
    if (RESERVED.includes(subdomain)) {
      throw new ConflictException('That subdomain is reserved');
    }

    const exists = await this.db.adminQuery(
      'SELECT 1 FROM tenants WHERE subdomain = $1',
      [subdomain],
    );
    if (exists.rowCount) {
      throw new ConflictException('A clinic with that subdomain already exists');
    }

    const trialEnds =
      dto.trialDays && dto.trialDays > 0
        ? new Date(Date.now() + dto.trialDays * 86_400_000)
        : null;

    return this.db.withAdminTransaction(async (client) => {
      const t = await client.query<{ id: string }>(
        `INSERT INTO tenants (name, subdomain, status, plan_id, trial_ends_at)
         VALUES ($1, $2, 'active', $3, $4)
         RETURNING id`,
        [dto.clinicName, subdomain, dto.planId ?? null, trialEnds],
      );
      const tenantId = t.rows[0]!.id;

      const hash = await bcrypt.hash(dto.ownerPassword, BCRYPT_ROUNDS);
      await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
         VALUES ($1, $2, $3, $4, 'owner', 'active')`,
        [tenantId, dto.ownerEmail, hash, dto.ownerFullName],
      );

      await this.audit.record(client, actor, {
        action: 'tenant.created',
        entityType: 'tenant',
        entityId: tenantId,
        metadata: {
          name: dto.clinicName,
          subdomain,
          ownerEmail: dto.ownerEmail,
          trialDays: dto.trialDays ?? 0,
        },
      });

      return { id: tenantId, subdomain };
    });
  }

  async updateStatus(
    id: string,
    status: 'active' | 'suspended' | 'archived',
    actor: AuditActor,
  ) {
    return this.db.withAdminTransaction(async (client) => {
      const current = await client.query<{ status: string; subdomain: string }>(
        'SELECT status, subdomain FROM tenants WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Tenant not found');

      await client.query('UPDATE tenants SET status = $1, updated_at = now() WHERE id = $2', [
        status,
        id,
      ]);

      const action =
        status === 'suspended'
          ? 'tenant.suspended'
          : status === 'archived'
            ? 'tenant.archived'
            : 'tenant.reactivated';

      await this.audit.record(client, actor, {
        action,
        entityType: 'tenant',
        entityId: id,
        metadata: { from: row.status, to: status, subdomain: row.subdomain },
      });

      return { id, status };
    });
  }
}
