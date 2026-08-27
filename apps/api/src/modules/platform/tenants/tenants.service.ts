import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '@/core/database/database.service';
import { PlatformAuditService, PlatformAuditActor } from '../audit/audit.service';
import { BCRYPT_ROUNDS } from '@/core/security/bcrypt';
import { CreateTenantDto } from './dto/tenant.dto';

const RESERVED = ['www', 'admin', 'api', 'app', 'mail', 'static'];

@Injectable()
export class TenantsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: PlatformAuditService,
  ) {}

  async list() {
    const { rows } = await this.db.adminQuery(
      `SELECT t.id, t.name, t.subdomain, t.status, t.trial_ends_at, t.created_at,
              p.name AS plan_name,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
              (SELECT email FROM users u
                WHERE u.tenant_id = t.id AND u.role = 'admin'
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
      `SELECT id, email, full_name, role, status
         FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [id],
    );
    const audit = await this.audit.listForEntity('tenant', id);
    return { ...tenant, staff: owners.rows, audit };
  }

  async create(dto: CreateTenantDto, actor: PlatformAuditActor) {
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

      // 'owner' was the pre-0012 spelling. 0012 narrowed users_role_check to
      // admin|dentist|receptionist and 0017 to admin|receptionist, but this
      // insert was never updated — so every clinic created from the panel died
      // on a constraint violation. The doctor is the admin.
      const hash = await bcrypt.hash(dto.ownerPassword, BCRYPT_ROUNDS);
      await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
         VALUES ($1, $2, $3, $4, 'admin', 'active')`,
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
    actor: PlatformAuditActor,
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

  /**
   * Set, extend or end a trial.
   *
   * `days === null` converts the clinic to paid: `trial_ends_at` goes NULL and
   * the read-only lock lifts. Anything else is a new deadline counted from
   * now, which is what "extend by 7" means to the person clicking it — not
   * "add 7 to a date that may already be in the past".
   */
  async setTrial(id: string, days: number | null, actor: PlatformAuditActor) {
    return this.db.withAdminTransaction(async (client) => {
      const current = await client.query<{ trial_ends_at: Date | null; subdomain: string }>(
        'SELECT trial_ends_at, subdomain FROM tenants WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Tenant not found');

      const next = days === null ? null : new Date(Date.now() + days * 86_400_000);

      await client.query(
        'UPDATE tenants SET trial_ends_at = $1, updated_at = now() WHERE id = $2',
        [next, id],
      );

      await this.audit.record(client, actor, {
        action: days === null ? 'tenant.converted_to_paid' : 'tenant.trial_set',
        entityType: 'tenant',
        entityId: id,
        metadata: {
          subdomain: row.subdomain,
          from: row.trial_ends_at ? row.trial_ends_at.toISOString() : null,
          to: next ? next.toISOString() : null,
          days,
        },
      });

      return { id, trialEndsAt: next ? next.toISOString() : null };
    });
  }

  /**
   * Reset a clinic user's password from the platform side — the recovery path
   * when a doctor locks themselves out, since the clinic plane has no email
   * flow.
   *
   * This is NODE X reaching into a customer's clinic, so it is recorded twice:
   * in the platform audit log, and in the CLINIC's own trail, where the doctor
   * can see it. A support action the customer cannot see is indistinguishable
   * from one they were not told about.
   */
  async resetUserPassword(
    tenantId: string,
    userId: string,
    password: string,
    actor: PlatformAuditActor,
  ) {
    return this.db.withAdminTransaction(async (client) => {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const res = await client.query<{ email: string; full_name: string }>(
        `UPDATE users SET password_hash = $3, updated_at = now()
          WHERE id = $2 AND tenant_id = $1
          RETURNING email, full_name`,
        [tenantId, userId, hash],
      );
      const user = res.rows[0];
      if (!user) throw new NotFoundException('User not found in this clinic');

      await this.audit.record(client, actor, {
        action: 'tenant.user_password_reset',
        entityType: 'tenant',
        entityId: tenantId,
        metadata: { userId, email: user.email },
      });

      // The clinic's own log. clinic_audit_log has FORCE ROW LEVEL SECURITY,
      // which applies to the table owner as well as to app_user, so the tenant
      // has to be set for this transaction before the insert will land.
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [
        tenantId,
      ]);
      await client.query(
        `INSERT INTO clinic_audit_log
           (tenant_id, actor_user_id, actor_label, actor_role,
            action, entity_type, entity_id, summary, metadata)
         VALUES ($1, NULL, $2, 'platform', 'staff.password_reset', 'user', $3, $4, $5)`,
        [
          tenantId,
          actor.label,
          userId,
          `NODE X support reset the password for ${user.full_name}`,
          JSON.stringify({ email: user.email, viaPlatform: true }),
        ],
      );

      return { reset: true as const, email: user.email };
    });
  }
}
