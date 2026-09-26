import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@/core/database/database.service';

/** The families of platform action, by the prefix they are recorded under. */
export const ACTIVITY_CATEGORIES = {
  clinics: 'tenant.',
  billing: 'platform.billing.',
  plans: 'plan.',
} as const;
export type ActivityCategory = keyof typeof ACTIVITY_CATEGORIES;

export interface ActivityQuery {
  category?: ActivityCategory;
  /** Keyset cursor: the created_at and id of the last row already shown. */
  before?: { at: string; id: string };
  limit: number;
}

export interface ActivityRow {
  id: string;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  /** The clinic the entry is about, when there is one — directly or via its invoice. */
  tenant_id: string | null;
  tenant_name: string | null;
  subdomain: string | null;
  invoice_number: string | null;
  plan_name: string | null;
}

/** Where the next page starts. Opaque to the console; it hands it back as-is. */
export interface ActivityCursor {
  before: string;
  beforeId: string;
}

/**
 * Everything the console has done, newest first, across every clinic.
 *
 * Each clinic's own page shows its slice of this trail; this is the whole of
 * it — the screen someone opens to answer "who suspended that clinic on
 * Tuesday" without first having to guess which clinic.
 *
 * Paged by (created_at, id) rather than OFFSET: rows arriving while someone
 * reads would otherwise shift every page by one and show an entry twice.
 */
@Injectable()
export class PlatformActivityService {
  constructor(private readonly db: DatabaseService) {}

  async list(
    q: ActivityQuery,
  ): Promise<{ rows: ActivityRow[]; next: ActivityCursor | null }> {
    const prefix = q.category ? ACTIVITY_CATEGORIES[q.category] : null;
    const { rows } = await this.db.adminQuery<ActivityRow & { cursor_at: string }>(
      // cursor_at keeps the microseconds. created_at goes out as a JSON date,
      // which stops at milliseconds, and a cursor rounded down to the
      // millisecond would skip any row written later in that same millisecond.
      `SELECT to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
              a.id, a.actor_label, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at,
              coalesce(t.id, it.id) AS tenant_id,
              coalesce(t.name, it.name) AS tenant_name,
              coalesce(t.subdomain, it.subdomain) AS subdomain,
              si.number AS invoice_number,
              p.name AS plan_name
         FROM audit_log a
         LEFT JOIN tenants t
           ON a.entity_type = 'tenant' AND t.id = a.entity_id
         LEFT JOIN subscription_invoices si
           ON a.entity_type = 'subscription_invoice' AND si.id = a.entity_id
         LEFT JOIN tenants it ON it.id = si.tenant_id
         LEFT JOIN plans p
           ON a.entity_type = 'plan' AND p.id = a.entity_id
        WHERE a.actor_type = 'platform_admin'
          AND ($1::text IS NULL OR starts_with(a.action, $1))
          AND ($2::timestamptz IS NULL OR (a.created_at, a.id) < ($2::timestamptz, $3::uuid))
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $4`,
      [prefix, q.before?.at ?? null, q.before?.id ?? null, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      rows: page.map(({ cursor_at: _cursor, ...row }) => row),
      next:
        rows.length > q.limit && last
          ? { before: last.cursor_at, beforeId: last.id }
          : null,
    };
  }
}
