import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';

export interface PlatformAuditActor {
  type: 'platform_admin';
  id: string;
  label: string;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

interface Executor {
  query: PoolClient['query'];
}

@Injectable()
export class PlatformAuditService {
  constructor(private readonly db: DatabaseService) {}

  /** Record within an existing transaction (preferred for create/status flows). */
  async record(executor: Executor, actor: PlatformAuditActor, entry: AuditEntry) {
    await executor.query(
      `INSERT INTO audit_log
         (actor_type, actor_id, actor_label, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        actor.type,
        actor.id,
        actor.label,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }

  async listForEntity(entityType: string, entityId: string) {
    const { rows } = await this.db.adminQuery(
      `SELECT id, actor_label, action, metadata, created_at
         FROM audit_log
        WHERE entity_type = $1 AND entity_id = $2
        ORDER BY created_at DESC
        LIMIT 100`,
      [entityType, entityId],
    );
    return rows;
  }
}
