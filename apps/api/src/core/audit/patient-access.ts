import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { normalizeRole } from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import type { RequestWithUser } from '@/shared/types/request-with-user';

/**
 * Who opened which part of whose record.
 *
 * The activity trail (clinic_audit_log) answers "who changed this". It cannot
 * answer the question a patient, a regulator or a clinic owner asks after a
 * privacy complaint: "who LOOKED at my records?". That is this table.
 *
 * ── Recorded on admission, and fail closed ────────────────────────────────
 *
 * The entry is written by a guard, after authentication and the permission
 * check and before the handler reads anything. If the write fails, the request
 * fails and the read never happens. An access log with holes in it proves
 * nothing about the reads that fell through them, so a read that cannot be
 * recorded is refused rather than served unrecorded.
 *
 * Recording on admission rather than after a successful response means an
 * authorised request for a real patient is logged even if the handler then
 * errors. That errs toward recording too much, which is the right direction.
 * A request for a patient id that does not exist records nothing.
 *
 * (A guard rather than an interceptor also keeps rxjs out of this path: the
 * API carries its own copy, and an interceptor typed against it does not
 * satisfy the NestInterceptor contract Nest compiles against.)
 *
 * ── Volume ────────────────────────────────────────────────────────────────
 *
 * Repeat views by the same person of the same part of the same record within
 * five minutes collapse into the first. Opening a chart, switching tabs and
 * coming back is one access, not six. See migration 0004 for the partitioning
 * path if a clinic outgrows that.
 */

export const PATIENT_RESOURCES = [
  'record',
  'chart',
  'procedures',
  'perio',
  'history',
  'documents',
  'document_file',
  'treatment_plans',
  'billing',
  /** A patient's conversation: the messages sent to them (0012). */
  'messages',
] as const;
export type PatientResource = (typeof PATIENT_RESOURCES)[number];

export interface PatientAccessActor {
  userId: string;
  label: string;
  role: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PatientAccessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  async record(
    tenantId: string,
    patientId: string,
    resource: PatientResource,
    actor: PatientAccessActor,
  ): Promise<void> {
    await this.db.withTenant(tenantId, (client) =>
      client.query(
        `INSERT INTO patient_access_log
           (tenant_id, patient_id, actor_user_id, actor_label, actor_role, resource)
         SELECT $1, $2, $3, $4, $5, $6
          WHERE EXISTS (SELECT 1 FROM patients WHERE id = $2)
            AND NOT EXISTS (
                  SELECT 1 FROM patient_access_log
                   WHERE patient_id = $2
                     AND actor_user_id = $3
                     AND resource = $6
                     AND accessed_at > now() - interval '5 minutes')`,
        [tenantId, patientId, actor.userId, actor.label, actor.role, resource],
      ),
    );
  }

  /** The record's access history, newest first. Gated on `audit:read`. */
  list(patientId: string, limit = 200) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        resource: PatientResource;
        accessed_at: string;
        actor_user_id: string | null;
        actor_label: string;
        actor_role: string;
        current_name: string | null;
      }>(
        `SELECT l.id, l.resource, l.accessed_at, l.actor_user_id, l.actor_label,
                l.actor_role, u.full_name AS current_name
           FROM patient_access_log l
           LEFT JOIN users u ON u.id = l.actor_user_id
          WHERE l.patient_id = $1
          ORDER BY l.accessed_at DESC
          LIMIT $2`,
        [patientId, Math.min(Math.max(limit, 1), 500)],
      );
      return rows.map((r) => ({
        id: r.id,
        resource: r.resource,
        accessedAt: r.accessed_at,
        actor: {
          userId: r.actor_user_id,
          label: r.actor_label,
          role: r.actor_role,
          currentName: r.current_name,
        },
      }));
    });
  }
}

const RESOURCE_KEY = 'patientAccessResource';

/**
 * Runs after the controller's JwtAuthGuard and PermissionsGuard — method
 * guards follow class guards — so only an authenticated caller who holds the
 * route's permission is ever recorded, and every one who does is.
 */
@Injectable()
export class PatientAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: PatientAccessService,
    private readonly tenant: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const resource = this.reflector.get<PatientResource | undefined>(
      RESOURCE_KEY,
      context.getHandler(),
    );
    if (!resource) return true;

    const req = context
      .switchToHttp()
      .getRequest<RequestWithUser & { params: Record<string, string | undefined> }>();
    const tenantId = this.tenant.getTenantId();
    const patientId = req.params.patientId ?? req.params.id;
    const user = req.user;
    const role = normalizeRole(user?.role);

    // A malformed id is refused by ParseUUIDPipe after this guard; recording
    // nothing for it is correct, and passing it to Postgres would be a 500.
    if (!tenantId || !patientId || !UUID.test(patientId) || !user || !role) return true;

    await this.access.record(tenantId, patientId, resource, {
      userId: user.sub,
      label: user.email,
      role,
    });
    return true;
  }
}

/**
 * Record a read of one part of a patient's record. The patient id comes from
 * the route's `:patientId` parameter, or `:id` where the patient IS the
 * resource.
 */
export function LogPatientAccess(resource: PatientResource) {
  return applyDecorators(SetMetadata(RESOURCE_KEY, resource), UseGuards(PatientAccessGuard));
}
