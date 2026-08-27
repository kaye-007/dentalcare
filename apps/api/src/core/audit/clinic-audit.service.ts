import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { TenantContextService } from '../tenancy/tenant-context';
import { Role, normalizeRole } from '../authz/permissions';

/**
 * The clinic-plane audit log.
 *
 * Distinct from `platform/audit`, which records what NODE X does to clinics.
 * This records what a clinic's own staff do inside it, and it exists for one
 * concrete reason: reception can fix a mistake, and must not be able to make
 * one disappear. Voiding a cash payment is allowed; voiding it invisibly is
 * not.
 *
 * Two rules make it evidence rather than a log file:
 *
 *  1. Every entry is written with the SAME client as the thing it describes,
 *     inside that transaction. A payment that commits without its audit row,
 *     or an audit row for a payment that rolled back, would both be worse than
 *     no log at all.
 *
 *  2. Nothing can amend it. Migration 0018 revokes UPDATE/DELETE/TRUNCATE from
 *     app_user and adds a trigger that raises on all three, so the row that
 *     lands here is the row that stays here.
 */

export const AUDIT_ACTIONS = [
  'invoice.created',
  'invoice.cancelled',
  'invoice.adjusted',
  'payment.recorded',
  'payment.voided',
  'expense.recorded',
  'expense.voided',
  'staff.created',
  'staff.updated',
  'staff.password_reset',
  'salary.recorded',
  'settings.updated',
  'treatment.created',
  'treatment.updated',
  'document.deleted',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface ClinicAuditActor {
  userId: string;
  /** Email — the snapshot that survives the account being unlinked. */
  label: string;
  /** Role AT THE TIME. A later promotion must not rewrite old rows. */
  role: Role;
}

export interface ClinicAuditEntry {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  /** One human-readable line. The Activity page reads this, not metadata. */
  summary: string;
  metadata?: Record<string, unknown>;
}

interface Executor {
  query: PoolClient['query'];
}

/**
 * Build an actor from a verified access token.
 *
 * Structurally typed rather than importing AccessTokenPayload, because core/
 * must not depend on tenant/. Fails closed: an unresolvable role is a 401, not
 * an entry attributed to nobody.
 */
export function auditActor(user?: {
  sub: string;
  email: string;
  role: unknown;
}): ClinicAuditActor {
  if (!user) throw new UnauthorizedException();
  const role = normalizeRole(user.role);
  if (!role) throw new UnauthorizedException('Your account has no valid access role');
  return { userId: user.sub, label: user.email, role };
}

export interface AuditFilter {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  /** ISO dates, inclusive. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  actor: { userId: string | null; label: string; role: string; currentName: string | null };
}

@Injectable()
export class ClinicAuditService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Record an action. MUST be given the client of the transaction that
   * performed it — never `this.db` — so the two commit or fail together.
   */
  async record(
    executor: Executor,
    actor: ClinicAuditActor,
    entry: ClinicAuditEntry,
  ): Promise<void> {
    const tenantId = this.tenant.getRequiredTenantId();
    await executor.query(
      `INSERT INTO clinic_audit_log
         (tenant_id, actor_user_id, actor_label, actor_role,
          action, entity_type, entity_id, summary, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        tenantId,
        actor.userId,
        actor.label,
        actor.role,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.summary,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }

  /** Read the log. Gated on `audit:read`, which only the doctor holds. */
  async list(filter: AuditFilter = {}): Promise<{ items: AuditRow[]; total: number }> {
    const tenantId = this.tenant.getRequiredTenantId();
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);

    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('$$', `$${params.length}`));
    };

    if (filter.action) add('a.action = $$', filter.action);
    if (filter.entityType) add('a.entity_type = $$', filter.entityType);
    if (filter.entityId) add('a.entity_id = $$', filter.entityId);
    if (filter.actorUserId) add('a.actor_user_id = $$', filter.actorUserId);
    if (filter.from) add('a.created_at >= $$::date', filter.from);
    // Inclusive of the whole end day, which is what a date picker means.
    if (filter.to) add("a.created_at < ($$::date + interval '1 day')", filter.to);

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    return this.db.withTenant(tenantId, async (client) => {
      const counted = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM clinic_audit_log a ${clause}`,
        params,
      );
      const { rows } = await client.query(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.summary, a.metadata,
                a.created_at, a.actor_user_id, a.actor_label, a.actor_role,
                u.full_name AS current_name
           FROM clinic_audit_log a
           LEFT JOIN users u ON u.id = a.actor_user_id
           ${clause}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      return {
        total: Number(counted.rows[0]!.n),
        items: rows.map((r) => ({
          id: r.id,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          summary: r.summary,
          metadata: r.metadata ?? {},
          createdAt: r.created_at,
          actor: {
            userId: r.actor_user_id,
            label: r.actor_label,
            role: r.actor_role,
            currentName: r.current_name,
          },
        })),
      };
    });
  }
}
